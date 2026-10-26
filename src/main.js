"use strict";

const { app, BrowserWindow, ipcMain, safeStorage, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const SKILLS_PATH = "/platform/davis/copilot/v1/skills";
const QUERY_PATH = "/platform/storage/query/v1";
const REQUEST_TIMEOUT_MS = 180000;
const QUERY_MAX_RECORDS = 200;
const QUERY_POLL_LIMIT = 20;
const DEFAULT_TIMEFRAME_MS = 24 * 60 * 60 * 1000;
const SUPPLEMENTARY_MAX_CHARS = 15000;

const DATA_MODE_INSTRUCTION =
  "You are assisting an on-call engineer who cannot access the Dynatrace UI. Use the supplementary context and its query results " +
  "to give a concise, evidence-based answer with concrete frontend names, counts, time ranges, and user impact. Never include DQL, " +
  "query text, URLs, links, or instructions to open or operate the Dynatrace UI. Do not suggest UI steps. Distinguish confirmed " +
  "findings from missing or inconclusive telemetry. If the query failed or returned no usable data, say that frontend health " +
  "could not be assessed from the available telemetry; do not claim the system is healthy or absent.";

const FRONTEND_WORKFLOWS = {
  "website-health": {
    requiresInput: true,
    question: (value) => `Assess the health and user impact of the frontend application ${JSON.stringify(value)} over the last 2 hours. Identify error signals, slow interactions, affected user volume, and whether this appears isolated to this frontend. State what the telemetry can and cannot confirm.`,
    hints: "Query user.events for web frontend data using frontend.type == \"web\" and the named frontend's scalar frontend.name field over a 2-hour timeframe. Match the name case-insensitively. Summarize event volume and available error and duration signals; use only fields supported by the data model. Do not substitute infrastructure or backend-only health for frontend evidence.",
  },
  "system-health": {
    question: () => "Assess whether there is a system-wide frontend issue across all monitored web frontends over the last 2 hours. Compare frontend applications, identify which are affected, and distinguish broad impact from a single-frontend issue.",
    hints: "Query user.events for all web frontends using frontend.type == \"web\", grouped by frontend.name over the last 2 hours. Summarize event volume and available frontend error and duration signals per frontend. Use only fields supported by the data model.",
  },
  "session-health": {
    requiresInput: true,
    question: (value) => `Assess the recent RUM session health for the user tag ${JSON.stringify(value)}. Identify matching session count, frontend application, error count, session timing, and any evidence of a wider frontend issue.`,
    hints: "Query user.sessions, NOT user.events. Match exactly against dt.rum.user_tag, the session-level user identifier. Query from:now()-32h to:now() to account for recently ended sessions that may take 30+ minutes to be aggregated. Use frontend.name (array; filter with matchesValue), dt.rum.session.id, error.count, start_time, and end_time. If dt.rum.user_tag is missing or unpopulated, state that the tag cannot be matched and do not substitute a session ID or frontend name.",
  },
  "impact-scope": {
    requiresInput: true,
    question: (value) => `An end user reported this frontend symptom: ${JSON.stringify(value)}. Determine whether the available telemetry indicates impact to one user/session, many users, one frontend application, or multiple frontends over the last 2 hours.`,
    hints: "Query recent user.events where frontend.type == \"web\", grouped by frontend.name, and use available event/error/duration dimensions relevant to the reported symptom. Compare affected frontend counts and user/session counts only when those fields are present. Do not infer user impact from event counts alone.",
  },
  "frontend-errors": {
    question: () => "Find the most significant frontend errors across all monitored web applications over the last 2 hours. Rank affected frontends by observed impact and estimate affected users or sessions only when the telemetry supports it.",
    hints: "Query user.events for web frontends using frontend.type == \"web\" over the last 2 hours. Identify error events using characteristics.has_error == true, then aggregate by frontend.name and available error dimensions. Do not invent an error field or treat every user event as an error.",
  },
  "slow-pages": {
    question: () => "Identify the slowest frontend experiences across monitored web applications over the last 2 hours and determine whether slowness is isolated or widespread. Report measured latency and affected frontends/users only when available.",
    hints: "Query user.events for web frontends using frontend.type == \"web\" over the last 2 hours. Use user-interaction events (characteristics.has_user_interaction) and their duration/performance fields, grouped by frontend.name and page/action dimensions when present. Do not infer page-load performance from unrelated event duration or from backend latency alone.",
  },
};

let mainWindow = null;

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return {
      tenantUrl: typeof raw.tenantUrl === "string" ? raw.tenantUrl : "",
      tokenEnc: typeof raw.tokenEnc === "string" ? raw.tokenEnc : "",
      dataMode: raw.dataMode !== false,
    };
  } catch {
    return { tenantUrl: "", tokenEnc: "", dataMode: true };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8");
}

function publicSettings(settings) {
  return {
    tenantUrl: settings.tenantUrl,
    hasToken: Boolean(settings.tokenEnc),
    dataMode: settings.dataMode,
  };
}

function normalizeTenantUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("Enter a valid tenant URL, e.g. https://abc12345.apps.dynatrace.com");
  }
  if (url.protocol !== "https:") throw new Error("Tenant URL must start with https://");
  // Platform APIs live on the apps domain, not the classic live domain.
  url.hostname = url.hostname.replace(/\.live\.dynatrace\.com$/i, ".apps.dynatrace.com");
  return url.origin;
}

function encryptToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure token storage is not available on this machine.");
  }
  return safeStorage.encryptString(token).toString("base64");
}

function decryptToken(tokenEnc) {
  if (!tokenEnc) return "";
  try {
    return safeStorage.decryptString(Buffer.from(tokenEnc, "base64"));
  } catch {
    throw new Error("The saved token could not be decrypted. Re-enter it in Settings.");
  }
}

function resolveCredentials(override) {
  const saved = loadSettings();
  const tenantUrl = normalizeTenantUrl(override?.tenantUrl || saved.tenantUrl);
  const token = String(override?.token || "").trim() || decryptToken(saved.tokenEnc);
  if (!token) throw new Error("No token configured. Open Settings to add one.");
  return { tenantUrl, token };
}

async function describeHttpError(res) {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      const err = json?.error;
      detail = [err?.message || json?.message, err?.details?.errorMessage].filter(Boolean).join(": ") || body;
    } catch {
      detail = body;
    }
  } catch {
    // Body unreadable; status code alone is still useful.
  }
  detail = String(detail).slice(0, 500);
  if (res.status === 401) {
    return `Authentication failed (401). Check that the token is valid for this tenant. ${detail}`;
  }
  if (res.status === 403) {
    return `Access denied (403). The token is missing a required scope or permission policy (see Settings for the scope list). ${detail}`;
  }
  return `Dynatrace returned HTTP ${res.status}. ${detail}`;
}

async function callDynatrace(creds, apiPath, init, handleResponse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(creds.tenantUrl + apiPath, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${creds.token}`, ...init.headers },
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new Error(`Could not reach ${creds.tenantUrl}: ${err.cause?.message || err.message}`);
    }
    if (!res.ok) throw new Error(await describeHttpError(res));
    return await handleResponse(res);
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request to Dynatrace timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readConversationStream(res, emit) {
  const decoder = new TextDecoder();
  const notifications = [];
  let buffer = "";
  let answer = "";
  let result = null;

  const handleLine = (line) => {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    const data = evt.data || {};
    switch (evt.event) {
      case "progress":
        emit({ type: "progress", message: data.message || "" });
        break;
      case "tokens": {
        const chunk = (data.tokens || []).join("");
        answer += chunk;
        emit({ type: "tokens", text: chunk });
        break;
      }
      case "notification":
        notifications.push(data);
        break;
      case "end":
        result = { text: data.answer ?? answer, state: data.state, sources: data.sources || [], notifications };
        break;
      case "error":
        throw new Error(data.message ? `${data.message} (${data.code})` : "Dynatrace Intelligence returned an error.");
      default:
        break;
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  buffer += decoder.decode();
  handleLine(buffer);

  return result || { text: answer, state: undefined, sources: [], notifications };
}

async function generateDql(creds, text) {
  const json = await callDynatrace(
    creds,
    `${SKILLS_PATH}/nl2dql:generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text }),
    },
    (res) => res.json()
  );
  if (json.status === "FAILED" || !json.dql) throw new Error("Dynatrace Intelligence could not generate a DQL query for this question.");
  return json.dql;
}

async function runDql(creds, query) {
  const post = (path, body) =>
    callDynatrace(
      creds,
      path,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
      (res) => res.json()
    );

  let r = await post(`${QUERY_PATH}/query:execute`, {
    query,
    defaultTimeframeStart: new Date(Date.now() - DEFAULT_TIMEFRAME_MS).toISOString(),
    defaultTimeframeEnd: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    locale: "en_US",
    requestTimeoutMilliseconds: 30000,
    maxResultRecords: QUERY_MAX_RECORDS,
  });
  for (let i = 0; (r.state === "RUNNING" || r.state === "NOT_STARTED") && r.requestToken; i++) {
    if (i >= QUERY_POLL_LIMIT) throw new Error("The DQL query took too long to complete.");
    const qs = new URLSearchParams({ "request-token": r.requestToken, "request-timeout-milliseconds": "10000" });
    r = await callDynatrace(creds, `${QUERY_PATH}/query:poll?${qs}`, { headers: { Accept: "application/json" } }, (res) =>
      res.json()
    );
  }
  if (r.state !== "SUCCEEDED") throw new Error(`DQL query ended in state ${r.state || "UNKNOWN"}.`);
  return r.result?.records || [];
}

function buildSupplementary(question, dql, records, error) {
  const header = `Question: ${question}\nDQL query run against the user's Dynatrace environment:\n${dql || "(none)"}\n`;
  if (error) return `${header}\nThe query failed: ${error}`;
  let json = JSON.stringify(records);
  let note = `${records.length} record(s) returned`;
  if (json.length > SUPPLEMENTARY_MAX_CHARS) {
    let kept = records.length;
    while (kept > 1 && JSON.stringify(records.slice(0, kept)).length > SUPPLEMENTARY_MAX_CHARS) kept = Math.floor(kept / 2);
    json = JSON.stringify(records.slice(0, kept)).slice(0, SUPPLEMENTARY_MAX_CHARS);
    note += `, showing the first ${kept}`;
  }
  const coverage = records.length === 0
    ? "\nCoverage warning: This query returned no rows. This does NOT establish that the application has no traffic, no monitoring data, or no performance issues. The query may use the wrong data source, entity identifier, filter, or timeframe. Classic RUM application data is not interchangeable with new RUM user.events or dt.frontend metrics. State that performance cannot be assessed from this query; do not claim the application is healthy or absent."
    : "";
  return `${header}\nResults (${note}):\n${json}${coverage}`;
}

function sessionCountQuery(question) {
  if (!/\bsessions?\b/i.test(question) || !/\berrors?\b/i.test(question)) return null;
  const application = question.match(/\b[A-Za-z0-9-]+_[A-Za-z0-9_-]+\b/);
  const threshold = question.match(/(?:error\s*count|errors?)\s*(?:is\s*)?(?:>|greater than|more than)\s*(\d+)\b/i);
  if (!application || !threshold) return null;
  if (/\b(yesterday|today|since|between|before|after|ago)\b|\d{4}-\d{2}-\d{2}/i.test(question)) return null;
  const timeframe = question.match(/\blast\s+(\d+)\s*(hours?|hrs?|h|days?|d|minutes?|mins?|m)\b/i);
  if (/\blast\b/i.test(question) && !timeframe) return null;
  const interval = timeframe ? `${timeframe[1]}${timeframe[2][0].toLowerCase()}` : "2h";
  return `fetch user.sessions, from:now()-${interval}, to:now()\n` +
    `| filter matchesValue(frontend.name, ${JSON.stringify(application[0])})\n` +
    `| filter error.count > ${threshold[1]}\n` +
    "| summarize matching_sessions=countDistinctExact(dt.rum.session.id)";
}

function resolveFrontendWorkflow(input) {
  if (!input) return null;
  const definition = FRONTEND_WORKFLOWS[input.id];
  if (!definition) throw new Error("Unknown frontend check.");
  const value = String(input.value || "").trim().slice(0, 500);
  if (definition.requiresInput && !value) throw new Error("Enter the requested frontend or user details.");
  return {
    question: definition.question(value),
    hints: definition.hints,
  };
}

async function queryEnvironment(creds, question, emit, workflow) {
  let dql = "";
  const sessionQuestion = /\bsessions?\b/i.test(question);
  const frontendQuestion = /frontend|website|ibanking|rum|apdex|web\s+app/i.test(question);
  const queryHints = workflow
    ? `\n${workflow.hints}`
    : sessionQuestion
    ? "\nQuery user.sessions, NOT user.events or classic usersessions. Verified session fields: frontend.name (ARRAY of application names), dt.rum.session.id (session ID), error.count (numeric total errors), start_time, end_time. Filter the frontend.name ARRAY using matchesValue(frontend.name, \"*application name*\"); NEVER use contains or scalar equality on this array. Do not compare names to entity IDs. For error count > 3 use filter error.count > 3 BEFORE aggregation. For a count use summarize matching_sessions=countDistinctExact(dt.rum.session.id), not a limited session list or event count. Preserve the requested threshold and comparison exactly. Use from:now()-2h, to:now() unless another timeframe is requested."
    : frontendQuestion
    ? "\nFor website performance, query user.events using frontend.name to match the application name, case-insensitively. User-action events can use characteristics.has_user_action and duration. Do not assume application names are entity IDs, or require page-summary/navigation characteristics to exist. Do not infer classic Apdex from event duration. Use from:now()-2h, to:now() unless the question specifies another timeframe."
    : "";
  const coverageHints = workflow?.id === "session-health"
    ? "Generate a coverage query against user.sessions grouped by frontend.name with total_sessions=countDistinctExact(dt.rum.session.id) and maximum_errors=max(error.count). Keep the exact dt.rum.user_tag match. Match frontend.name arrays using matchesValue. "
    : workflow?.id === "website-health"
    ? "Generate a simple coverage query against user.events for the named web frontend, grouped by frontend.name with count() and no performance/error filters. Match the scalar frontend.name case-insensitively. "
    : workflow
    ? "Generate a simple coverage query against user.events for all web frontends, grouped by frontend.name with count() and no performance/error filters. Do not add a frontend-name or symptom filter. "
    : "Generate a simple coverage query against user.events, grouped by frontend.name, with count() and no performance-characteristic filters. ";
  try {
    emit({ type: "progress", message: "Generating DQL query..." });
    dql = sessionCountQuery(question) || await generateDql(creds, question + queryHints);
    emit({ type: "progress", message: "Querying your environment..." });
    let records;
    try {
      records = await runDql(creds, dql);
    } catch (err) {
      emit({ type: "progress", message: "Query failed, generating a corrected query..." });
      dql = await generateDql(
        creds,
        `${question}${queryHints}\n\nThis DQL query failed with the error "${err.message}":\n${dql}\n` +
          "Write a corrected DQL query. Use a relative timeframe such as from:now()-24h and do not set a 'to' earlier than 'from'."
      );
      emit({ type: "progress", message: "Querying your environment..." });
      records = await runDql(creds, dql);
    }
    if ((frontendQuestion || sessionQuestion) && records.length === 0) {
      emit({ type: "progress", message: "No rows matched; checking data coverage..." });
      dql = await generateDql(
        creds,
        question + queryHints +
          `\nThe previous query returned zero rows:\n${dql}\n` +
          coverageHints +
          "This is a coverage check, not a performance verdict."
      );
      records = await runDql(creds, dql);
      return {
        dql,
        recordCount: records.length,
        supplementary: buildSupplementary(question, dql, records) +
          "\nThis is a fallback coverage query. Counts establish data coverage only; they do not answer the original filtered question or establish absence of errors or performance problems. State that the original query was inconclusive."
      };
    }
    return { dql, recordCount: records.length, supplementary: buildSupplementary(question, dql, records) };
  } catch (err) {
    return { dql, queryError: err.message, supplementary: buildSupplementary(question, dql, [], err.message) };
  }
}

function registerIpc() {
  ipcMain.handle("settings:get", () => publicSettings(loadSettings()));

  ipcMain.handle("settings:save", (_event, input) => {
    const current = loadSettings();
    const token = String(input?.token || "").trim();
    const next = {
      tenantUrl: normalizeTenantUrl(input?.tenantUrl),
      tokenEnc: token ? encryptToken(token) : current.tokenEnc,
      dataMode: input?.dataMode !== false,
    };
    writeSettings(next);
    return publicSettings(next);
  });

  ipcMain.handle("connection:test", async (_event, override) => {
    const creds = resolveCredentials(override);
    const data = await callDynatrace(creds, SKILLS_PATH, { headers: { Accept: "application/json" } }, (res) =>
      res.json()
    );
    const skills = Array.isArray(data?.skills) ? data.skills : [];
    return { skills, chatAvailable: skills.includes("conversation"), nl2dqlAvailable: skills.includes("nl2dql") };
  });

  ipcMain.handle("chat:send", async (event, request) => {
    const workflow = resolveFrontendWorkflow(request?.workflow);
    const text = workflow?.question || String(request?.text || "").trim();
    if (!text) throw new Error("Prompt is empty.");
    const creds = resolveCredentials();
    const emit = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send("chat:event", { requestId: request.requestId, ...payload });
    };

    const body = { text: text.slice(0, 10000) };
    if (request.state) body.state = request.state;

    let data = null;
    if (workflow || loadSettings().dataMode) {
      data = await queryEnvironment(creds, body.text, emit, workflow);
      body.context = [
        { type: "supplementary", value: data.supplementary },
        { type: "instruction", value: DATA_MODE_INSTRUCTION },
        { type: "document-retrieval", value: "dynatrace" },
      ];
      emit({ type: "progress", message: "Analyzing results..." });
    }

    const answer = await callDynatrace(
      creds,
      `${SKILLS_PATH}/conversations:message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(body),
      },
      async (res) => {
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("ndjson")) return readConversationStream(res, emit);
        const json = await res.json();
        if (json.status === "FAILED") throw new Error(json.text || "Dynatrace Intelligence could not answer this prompt.");
        return {
          text: json.text || "",
          state: json.state,
          sources: json.metadata?.sources || [],
          notifications: json.metadata?.notifications || [],
        };
      }
    );
    return { ...answer, sources: [] };
  });

}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: "Dynatrace OnCall",
    backgroundColor: "#0f1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
  });

  app.on("window-all-closed", () => app.quit());
}

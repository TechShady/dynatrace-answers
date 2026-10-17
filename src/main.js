"use strict";

const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu } = require("electron");
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
  "You are assisting an on-call engineer. The supplementary context contains a DQL query that was run against the user's " +
  "Dynatrace environment and its results. Answer the question using those results: cite concrete names, counts and values. " +
  "If the results are empty, say so plainly and suggest how to refine the question. If the query failed, explain that and " +
  "suggest a corrected DQL query. Do not claim you lack access to the environment.";

const DEFAULT_PROMPTS = [
  {
    label: "Triage a problem",
    prompt: "Walk me through triaging an open Dynatrace problem as the on-call engineer. What should I check first?",
  },
  {
    label: "Error logs (DQL)",
    prompt: "Write a DQL query that shows error logs from the last hour grouped by service, sorted by count.",
  },
  {
    label: "Failing services",
    prompt: "How do I find the services with the highest failure rate right now? Include a DQL query.",
  },
  {
    label: "Host saturation",
    prompt: "Write a DQL query to find hosts with CPU usage above 90% in the last 30 minutes.",
  },
  {
    label: "Slow endpoints",
    prompt: "How do I find the slowest endpoints and trace them to their root cause in Dynatrace?",
  },
];

let mainWindow = null;

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function sanitizePrompts(list) {
  return list
    .filter((p) => p && typeof p.label === "string" && typeof p.prompt === "string")
    .map((p) => ({ label: p.label.trim().slice(0, 60), prompt: p.prompt.trim().slice(0, 4000) }))
    .filter((p) => p.label && p.prompt)
    .slice(0, 30);
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return {
      tenantUrl: typeof raw.tenantUrl === "string" ? raw.tenantUrl : "",
      tokenEnc: typeof raw.tokenEnc === "string" ? raw.tokenEnc : "",
      prompts: Array.isArray(raw.prompts) ? sanitizePrompts(raw.prompts) : DEFAULT_PROMPTS,
      dataMode: raw.dataMode !== false,
    };
  } catch {
    return { tenantUrl: "", tokenEnc: "", prompts: DEFAULT_PROMPTS, dataMode: true };
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
    prompts: settings.prompts,
    dataMode: settings.dataMode,
    defaultPrompts: DEFAULT_PROMPTS,
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
  return `${header}\nResults (${note}):\n${json}`;
}

async function queryEnvironment(creds, question, emit) {
  let dql = "";
  try {
    emit({ type: "progress", message: "Generating DQL query..." });
    dql = await generateDql(creds, question);
    emit({ type: "progress", message: "Querying your environment..." });
    let records;
    try {
      records = await runDql(creds, dql);
    } catch (err) {
      emit({ type: "progress", message: "Query failed, generating a corrected query..." });
      dql = await generateDql(
        creds,
        `${question}\n\nThis DQL query failed with the error "${err.message}":\n${dql}\n` +
          "Write a corrected DQL query. Use a relative timeframe such as from:now()-24h and do not set a 'to' earlier than 'from'."
      );
      emit({ type: "progress", message: "Querying your environment..." });
      records = await runDql(creds, dql);
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
      prompts: sanitizePrompts(Array.isArray(input?.prompts) ? input.prompts : []),
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
    const text = String(request?.text || "").trim();
    if (!text) throw new Error("Prompt is empty.");
    const creds = resolveCredentials();
    const emit = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send("chat:event", { requestId: request.requestId, ...payload });
    };

    const body = { text: text.slice(0, 10000) };
    if (request.state) body.state = request.state;

    let data = null;
    if (loadSettings().dataMode) {
      data = await queryEnvironment(creds, body.text, emit);
      emit({ type: "data", dql: data.dql, recordCount: data.recordCount, queryError: data.queryError });
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
    return data ? { ...answer, dql: data.dql, recordCount: data.recordCount, queryError: data.queryError } : answer;
  });

  ipcMain.handle("open-external", (_event, rawUrl) => {
    const url = new URL(String(rawUrl));
    if (url.protocol === "https:") return shell.openExternal(url.toString());
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

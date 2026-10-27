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
const FRONTEND_HEALTH_METRICS_DQL =
  "timeseries errors = sum(dt.frontend.error.count, scalar: true), " +
  "requests = sum(dt.frontend.request.count, scalar: true), " +
  "lcp_p75 = percentile(dt.frontend.web.page.largest_contentful_paint, 75, scalar: true), " +
  "inp_p75 = percentile(dt.frontend.web.page.interaction_to_next_paint, 75, scalar: true), " +
  "by:{frontend.name}, from:now()-2h";
const FRONTEND_HEALTH_PREVIOUS_METRICS_DQL = `${FRONTEND_HEALTH_METRICS_DQL}, shift:-2h`;
const FRONTEND_LIST_DQL =
  "timeseries requests = sum(dt.frontend.request.count, scalar: true), " +
  "by:{frontend.name}, from:now()-24h";

const DATA_MODE_INSTRUCTION =
  "You are assisting an on-call engineer who cannot access the Dynatrace UI. Use the supplementary context and its query results " +
  "to give a concise, evidence-based answer with concrete frontend names, counts, time ranges, and user impact. Never include DQL, " +
  "query text, URLs, links, or instructions to open or operate the Dynatrace UI. Do not suggest UI steps. Distinguish confirmed " +
  "Never tell the user to ask an administrator, enable Agentic AI, create or run DQL, or access Dynatrace. " +
  "findings from missing or inconclusive telemetry. When frontend metric summaries are provided, cover both error trends and page " +
  "performance (P75 LCP and INP); do not treat error counts alone as overall health or label aggregate errors as JavaScript exceptions. " +
  "If the query failed or returned no usable data, say that frontend health " +
  "could not be assessed from the available telemetry; do not claim the system is healthy or absent.";

const FRONTEND_WORKFLOWS = {
  "website-health": {
    requiresInput: true,
    question: (value) => `Assess the health and user impact of the frontend application ${JSON.stringify(value)} using its error-rate trend and page performance (LCP and INP) over the latest two hours versus the prior two hours. Identify whether errors or page performance are degraded, and distinguish frontend-wide evidence from user-specific impact.`,
    hints: "The supplied context contains frontend error/request totals and LCP/INP metrics for two adjacent two-hour periods. Compare both error rates and page performance, and report the actual frontend name. These aggregate errors do not classify JavaScript exceptions; do not claim a specific error type without detailed event data.",
  },
  "system-health": {
    question: () => "Assess whether errors or page performance issues are widespread across frontends. Compare current versus prior two-hour error rates, LCP, and INP, and identify whether impact is concentrated in one frontend or spans several.",
    hints: "The context includes error/request trends and page performance metrics for each frontend. Cover both errors and LCP/INP; distinguish aggregate frontend errors from JavaScript exceptions.",
  },
  "session-health": {
    requiresInput: true,
    question: (value) => `Assess the recent health for user tag ${JSON.stringify(value)}. Report matching session errors where available, plus error trends and LCP/INP for the frontend applications used by those sessions. Distinguish session-specific findings from frontend-wide impact.`,
    hints: "The context includes user.sessions matched by dt.rum.user_tag and frontend metric comparisons. Cover both session errors and frontend error/performance metrics. user.sessions records may lag by 30+ minutes; do not interpret missing recent sessions as proof of no user impact.",
  },
  "impact-scope": {
    requiresInput: true,
    options: [
      "Slow page load",
      "Slow or unresponsive interactions",
      "JavaScript errors or broken controls",
      "Failed requests or API errors",
      "Blank page or navigation failure",
      "Login or authentication problems",
      "Visual layout or missing content",
      "Other or not yet known",
    ],
    question: (value) => `An end user reported this frontend symptom: ${JSON.stringify(value)}. Use error trends and page performance (LCP/INP) to determine whether the telemetry points to one frontend or a broader issue. State whether it can establish impact to one user/session versus many.`,
    hints: "The context contains frontend error/request trends and LCP/INP by application. Compare both error and performance signals across applications. Do not infer user/session counts from aggregate metrics.",
  },
  "frontend-errors": {
    question: () => "Find frontends with the largest error-rate increases, and include their page-performance readings (LCP and INP) to show whether user experience is also degraded. Compare the latest two hours with the prior two hours.",
    hints: "The context contains aggregate error/request metrics and LCP/INP by frontend. Rank error increases, and report page performance for the same frontends. Do not label aggregate metric errors as JavaScript exceptions.",
  },
  "slow-pages": {
    question: () => "Identify frontends with the slowest LCP or INP and include their error-rate trends to determine whether performance degradation coincides with increased errors. Compare the latest two hours with the prior two hours.",
    hints: "The context contains LCP/INP and aggregate error/request metrics by frontend. Rank page performance issues and report error trends for those same frontends. LCP/INP values are milliseconds.",
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

async function runDql(creds, query, maxResultRecords = QUERY_MAX_RECORDS) {
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
    maxResultRecords,
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

function numericMetric(record, field) {
  const rawValue = record?.[field];
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function lcpStatus(value) {
  if (value === null) return null;
  return value > 4000 ? "poor" : value > 2500 ? "needs improvement" : "good";
}

function inpStatus(value) {
  if (value === null) return null;
  return value > 500 ? "poor" : value > 200 ? "needs improvement" : "good";
}

function summarizeFrontendMetricTrend(current, previous) {
  const previousErrors = numericMetric(previous, "errors");
  const currentErrors = numericMetric(current, "errors");
  const previousRequests = numericMetric(previous, "requests");
  const currentRequests = numericMetric(current, "requests");
  const previousLcp = numericMetric(previous, "lcp_p75");
  const currentLcp = numericMetric(current, "lcp_p75");
  const previousInp = numericMetric(previous, "inp_p75");
  const currentInp = numericMetric(current, "inp_p75");
  const previousRate = previousErrors !== null && previousRequests > 0 ? (previousErrors / previousRequests) * 100 : null;
  const currentRate = currentErrors !== null && currentRequests > 0 ? (currentErrors / currentRequests) * 100 : null;

  return {
    frontend_name: current["frontend.name"],
    comparison: "latest 2 hours versus previous 2 hours",
    previous_error_count: previousErrors,
    current_error_count: currentErrors,
    error_count_change: previousErrors !== null && currentErrors !== null ? currentErrors - previousErrors : null,
    error_count_change_percent: previousErrors > 0 && currentErrors !== null
      ? Math.round(((currentErrors - previousErrors) / previousErrors) * 1000) / 10
      : null,
    errors_started_from_zero: previousErrors === 0 && currentErrors > 0,
    previous_request_count: previousRequests,
    current_request_count: currentRequests,
    previous_error_rate_percent: previousRate === null ? null : Math.round(previousRate * 100) / 100,
    current_error_rate_percent: currentRate === null ? null : Math.round(currentRate * 100) / 100,
    error_rate_change_percentage_points: previousRate !== null && currentRate !== null
      ? Math.round((currentRate - previousRate) * 100) / 100
      : null,
    previous_lcp_p75_ms: previousLcp === null ? null : Math.round(previousLcp),
    current_lcp_p75_ms: currentLcp === null ? null : Math.round(currentLcp),
    current_lcp_p75_status: lcpStatus(currentLcp),
    previous_inp_p75_ms: previousInp === null ? null : Math.round(previousInp),
    current_inp_p75_ms: currentInp === null ? null : Math.round(currentInp),
    current_inp_p75_status: inpStatus(currentInp),
  };
}

function compactFrontendMetricSummary(summary) {
  return {
    frontend_name: summary.frontend_name,
    previous_error_count: summary.previous_error_count,
    current_error_count: summary.current_error_count,
    error_count_change_percent: summary.error_count_change_percent,
    previous_error_rate_percent: summary.previous_error_rate_percent,
    current_error_rate_percent: summary.current_error_rate_percent,
    error_rate_change_percentage_points: summary.error_rate_change_percentage_points,
    current_lcp_p75_ms: summary.current_lcp_p75_ms,
    current_lcp_p75_status: summary.current_lcp_p75_status,
    current_inp_p75_ms: summary.current_inp_p75_ms,
    current_inp_p75_status: summary.current_inp_p75_status,
  };
}

function prioritizeFrontendMetrics(summaries) {
  const top = (selector) => [...summaries]
    .filter((summary) => selector(summary) !== null && Number.isFinite(selector(summary)))
    .sort((a, b) => selector(b) - selector(a))
    .slice(0, 6)
    .map(compactFrontendMetricSummary);
  return {
    frontend_count: summaries.length,
    comparison: "latest two hours versus previous two hours",
    error_metric: "Aggregate frontend errors; not JavaScript-exception-specific.",
    performance_metrics: "P75 LCP and INP in milliseconds; thresholds follow standard web-vitals guidance.",
    highest_error_rates: top((summary) => summary.current_error_rate_percent),
    largest_error_rate_increases: top((summary) => summary.error_rate_change_percentage_points),
    slowest_lcp_p75: top((summary) => summary.current_lcp_p75_ms),
    slowest_inp_p75: top((summary) => summary.current_inp_p75_ms),
  };
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
  if (definition.options && !definition.options.includes(value)) throw new Error("Select a symptom from the list.");
  return {
    question: definition.question(value),
    hints: definition.hints,
    value,
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
    if (workflow) {
      emit({ type: "progress", message: "Querying frontend errors and page performance..." });
      dql = `${FRONTEND_HEALTH_METRICS_DQL}\n\n${FRONTEND_HEALTH_PREVIOUS_METRICS_DQL}`;
      const metricRecords = await runDql(creds, FRONTEND_HEALTH_METRICS_DQL);
      const previousMetricRecords = await runDql(creds, FRONTEND_HEALTH_PREVIOUS_METRICS_DQL);
      const previousMetricsByFrontend = new Map(previousMetricRecords
        .filter((record) => record["frontend.name"])
        .map((record) => [String(record["frontend.name"]).toLowerCase(), record]));
      const summaries = metricRecords
        .filter((record) => record["frontend.name"])
        .map((record) => summarizeFrontendMetricTrend(
          record,
          previousMetricsByFrontend.get(String(record["frontend.name"]).toLowerCase())
        ));
      let records;

      if (workflow.id === "website-health") {
        const requestedName = workflow.value.toLowerCase();
        const match = summaries.find((summary) => summary.frontend_name.toLowerCase() === requestedName);
        records = match
          ? [match]
          : metricRecords.length
          ? [{
              requested_frontend: workflow.value,
              metric_series_found: false,
              available_frontends: summaries.map((summary) => summary.frontend_name).slice(0, 50),
            }]
          : [];
      } else if (workflow.id === "session-health") {
        emit({ type: "progress", message: "Checking the tagged user session..." });
        const sessionDql = `fetch user.sessions, from:now()-32h, to:now()\n` +
          `| filter dt.rum.user_tag == ${JSON.stringify(workflow.value)}\n` +
          "| summarize matching_sessions=countDistinctExact(dt.rum.session.id), session_errors=sum(error.count), " +
          "frontend_names=collectDistinct(frontend.name)";
        dql += `\n\n${sessionDql}`;
        let sessionRecords = [];
        let sessionQueryError = null;
        try {
          sessionRecords = await runDql(creds, sessionDql);
        } catch (err) {
          sessionQueryError = err.message;
        }
        const sessionFrontendNames = sessionRecords.flatMap((record) => {
          const names = record.frontend_names;
          return Array.isArray(names) ? names.flat(Infinity).filter(Boolean) : names ? [names] : [];
        }).map((name) => String(name).toLowerCase());
        records = [{
          user_tag: workflow.value,
          session_records: sessionRecords,
          session_query_error: sessionQueryError,
          session_frontend_metrics: summaries
            .filter((summary) => sessionFrontendNames.includes(summary.frontend_name.toLowerCase()))
            .map(compactFrontendMetricSummary),
          overall_frontend_health: prioritizeFrontendMetrics(summaries),
        }];
      } else {
        records = [{
          workflow: workflow.id,
          ...(workflow.id === "impact-scope" ? { reported_symptom: workflow.value } : {}),
          ...prioritizeFrontendMetrics(summaries),
        }];
      }

      return {
        dql,
        recordCount: metricRecords.length,
        supplementary: buildSupplementary(question, dql, records),
      };
    }
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

  ipcMain.handle("frontends:list", async () => {
    const creds = resolveCredentials();
    const records = await runDql(creds, FRONTEND_LIST_DQL, 1000);
    return [...new Set(records.map((record) => String(record["frontend.name"] || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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

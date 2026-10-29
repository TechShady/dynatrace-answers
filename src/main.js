"use strict";

const { app, BrowserWindow, dialog, ipcMain, safeStorage, Menu } = require("electron");
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
const FRONTEND_PROBLEMS_DQL =
  "fetch dt.davis.problems, from:now()-4h\n" +
  "| filter not(dt.davis.is_duplicate)\n" +
  "| fields event.start, display_id, event.name, event.category, event.status, dt.davis.affected_users_count, root_cause_entity_name\n" +
  "| sort event.start desc\n" +
  "| limit 50";

const DATA_MODE_INSTRUCTION =
  "You are assisting an on-call engineer who cannot access the Dynatrace UI. Use the supplementary context and its query results " +
  "to give a concise, evidence-based answer with concrete frontend names, counts, time ranges, and user impact. Never include DQL, " +
  "query text, URLs, links, or instructions to open or operate the Dynatrace UI. Do not suggest UI steps. Distinguish confirmed " +
  "Never tell the user to ask an administrator, enable Agentic AI, create or run DQL, or access Dynatrace. " +
  "findings from missing or inconclusive telemetry. When frontend metric summaries are provided, cover both error trends and page " +
  "performance (P75 LCP and INP); do not treat error counts alone as overall health or label aggregate errors as JavaScript exceptions. " +
  "For a selected frontend, report its computed health_status and its own metric values. Never infer that a frontend is healthy or missing " +
  "because it does not appear in a fleet ranking. " +
  "Report telemetry coverage/confidence. Recent Davis problems are context only: do not claim causation from time overlap, and only call a problem directly related when its affected frontend or root-cause name explicitly matches. No deployment/change data is provided unless included in the context. " +
  "If the query failed or returned no usable data, say that frontend health " +
  "could not be assessed from the available telemetry; do not claim the system is healthy or absent.";

const FRONTEND_WORKFLOWS = {
  "website-health": {
    requiresInput: true,
    question: (value) => `Assess the selected frontend application ${JSON.stringify(value)} using its own metrics. Start with its computed health status, then cite the current and previous error rate, error counts, p75 LCP, and p75 INP. Do not infer this frontend is missing or healthy from fleet ranking lists. Distinguish frontend-wide telemetry from user-specific impact.`,
    hints: "The supplied context contains the exact selected frontend's computed health_status and direct metric values. Report that status and cite its error rate, error counts, p75 LCP, and p75 INP. Aggregate frontend errors are not JavaScript-exception-specific. If status is inconclusive, explain which measurements are missing and do not call the frontend healthy.",
  },
  "system-health": {
    question: () => "Assess whether errors or page performance issues are widespread across frontends. Compare current versus prior two-hour error rates, LCP, and INP, and identify whether impact is concentrated in one frontend or spans several.",
    hints: "The context includes error/request trends and page performance metrics for each frontend. Cover both errors and LCP/INP; distinguish aggregate frontend errors from JavaScript exceptions.",
  },
  "guided-triage": {
    requiresInput: true,
    question: (value) => `A caller reports: ${JSON.stringify(value)}. Triage the current frontend error and performance metrics across all frontends. Identify the most likely impact scope, distinguish confirmed evidence from possible overlap with Davis problems, and state what remains unknown.`,
    hints: "Use the supplied fleet metrics, coverage confidence, and recent Davis problem context. Start with the affected frontends and scope; state when a problem is only temporally nearby rather than directly matched. Do not invent deployment events or user counts.",
  },
  "session-health": {
    requiresInput: true,
    requiresConsent: true,
    question: (value) => value.sessionId
      ? `Assess session ID ${JSON.stringify(value.sessionId)}${value.userIdentifier ? ` for user identifier/tag ${JSON.stringify(value.userIdentifier)}` : ""}. Report activity for the matching session. If both identifiers were supplied, verify whether they match the same session.`
      : `Assess every session from the last seven days for user identifier/tag ${JSON.stringify(value.userIdentifier)}. Summarize activity, errors, frontend, and timing for each matching session.`,
    hints: "Session-specific records are primary evidence. A tag-only request returns every matching session from the last seven days; an ID-only request returns that session. Compare user.identifier and dt.rum.user_tag as scalar strings, and if both inputs are supplied verify they match the same session. If no records or events match, say so plainly; never substitute fleet-wide metrics or call the user healthy.",
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

async function runDql(creds, query, maxResultRecords = QUERY_MAX_RECORDS, timeframeStart = null) {
  const post = (path, body) =>
    callDynatrace(
      creds,
      path,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
      (res) => res.json()
    );

  let r = await post(`${QUERY_PATH}/query:execute`, {
    query,
    defaultTimeframeStart: timeframeStart || new Date(Date.now() - DEFAULT_TIMEFRAME_MS).toISOString(),
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

function escapePdfHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPdfHtml(messages) {
  const generatedAt = new Date().toLocaleString();
  const transcript = messages.map((message) => {
    const role = message.role === "assistant" ? "Dynatrace Intelligence" : message.role === "error" ? "Error" : "On-call";
    const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : "";
    return `<article><header><strong>${role}</strong><time>${escapePdfHtml(timestamp)}</time></header><pre>${escapePdfHtml(message.text)}</pre></article>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Dynatrace OnCall Case Notes</title><style>
    @page { size: A4; margin: 18mm; }
    body { color: #172033; font: 10.5pt/1.5 "Segoe UI", Arial, sans-serif; }
    h1 { margin: 0 0 4pt; font-size: 19pt; }
    .generated { color: #526071; font-size: 9pt; margin-bottom: 20pt; }
    article { break-inside: avoid; border: 1px solid #d5dce5; border-radius: 5px; margin: 0 0 12pt; padding: 10pt 12pt; }
    header { display: flex; justify-content: space-between; gap: 12pt; border-bottom: 1px solid #e4e9ef; padding-bottom: 5pt; margin-bottom: 7pt; }
    time { color: #526071; font-size: 8.5pt; }
    pre { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  </style></head><body><h1>Dynatrace OnCall Case Notes</h1><div class="generated">Exported ${escapePdfHtml(generatedAt)}</div>${transcript}</body></html>`;
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

function assessFrontendHealth(summary) {
  const missingCurrentMetrics = [
    summary.current_error_rate_percent === null ? "error rate" : null,
    summary.current_lcp_p75_ms === null ? "LCP p75" : null,
    summary.current_inp_p75_ms === null ? "INP p75" : null,
  ].filter(Boolean);
  const missingPreviousMetrics = [
    summary.previous_error_rate_percent === null ? "error rate" : null,
    summary.previous_lcp_p75_ms === null ? "LCP p75" : null,
    summary.previous_inp_p75_ms === null ? "INP p75" : null,
  ].filter(Boolean);
  const coverageStatus = missingCurrentMetrics.length
    ? "insufficient"
    : missingPreviousMetrics.length ? "partial" : "complete";
  if (missingCurrentMetrics.length) {
    return {
      health_status: "inconclusive",
      coverage_status: coverageStatus,
      missing_current_metrics: missingCurrentMetrics,
      missing_previous_metrics: missingPreviousMetrics,
      health_reasons: [`Missing current ${missingCurrentMetrics.join(", ")} telemetry.`],
    };
  }

  const reasons = [];
  if (summary.current_error_rate_percent > 1) {
    reasons.push(`Error rate ${summary.current_error_rate_percent}% exceeds the 1% review threshold.`);
  }
  if (summary.current_lcp_p75_status === "poor") {
    reasons.push(`P75 LCP is ${summary.current_lcp_p75_ms} ms, above the 4,000 ms poor threshold.`);
  } else if (summary.current_lcp_p75_status === "needs improvement") {
    reasons.push(`P75 LCP is ${summary.current_lcp_p75_ms} ms, above the 2,500 ms good threshold.`);
  }
  if (summary.current_inp_p75_status === "poor") {
    reasons.push(`P75 INP is ${summary.current_inp_p75_ms} ms, above the 500 ms poor threshold.`);
  } else if (summary.current_inp_p75_status === "needs improvement") {
    reasons.push(`P75 INP is ${summary.current_inp_p75_ms} ms, above the 200 ms good threshold.`);
  }
  if (summary.error_rate_change_percentage_points !== null && summary.error_rate_change_percentage_points >= 0.5) {
    reasons.push(`Error rate increased ${summary.error_rate_change_percentage_points} percentage points versus the prior period.`);
  }
  if (missingPreviousMetrics.length) {
    reasons.push(`Prior-period ${missingPreviousMetrics.join(", ")} telemetry is missing; comparison confidence is limited.`);
  }

  const degraded = summary.current_error_rate_percent > 1 ||
    summary.current_lcp_p75_status === "poor" ||
    summary.current_inp_p75_status === "poor";
  return {
    health_status: degraded ? "degraded" : missingPreviousMetrics.length ? "inconclusive" : reasons.length ? "watch" : "healthy",
    coverage_status: coverageStatus,
    missing_current_metrics: missingCurrentMetrics,
    missing_previous_metrics: missingPreviousMetrics,
    health_reasons: reasons.length ? reasons : ["Error rate, P75 LCP, and P75 INP are within the configured thresholds."],
  };
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

  const summary = {
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
  return { ...summary, ...assessFrontendHealth(summary) };
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
    health_status: summary.health_status,
    coverage_status: summary.coverage_status,
    missing_current_metrics: summary.missing_current_metrics,
    missing_previous_metrics: summary.missing_previous_metrics,
    health_reasons: summary.health_reasons,
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

function buildDavisProblemContext(problems, selectedFrontend, queryError) {
  const toSummary = (problem) => ({
    problem_id: problem.display_id,
    started_at: problem["event.start"],
    name: problem["event.name"],
    category: problem["event.category"],
    status: problem["event.status"],
    affected_users: numericMetric(problem, "dt.davis.affected_users_count"),
    root_cause: problem.root_cause_entity_name,
  });
  const selectedName = String(selectedFrontend || "").toLowerCase();
  const directlyNameMatched = selectedName
    ? problems.filter((problem) =>
        [problem["event.name"], problem.root_cause_entity_name]
          .some((value) => String(value || "").toLowerCase().includes(selectedName))
      )
    : [];

  return {
    query_status: queryError ? "unavailable" : "queried",
    query_error: queryError || undefined,
    recent_problem_count: problems.length,
    directly_name_matched_problems: directlyNameMatched.map(toSummary),
    other_recent_problems: problems
      .filter((problem) => !directlyNameMatched.includes(problem))
      .slice(0, 5)
      .map(toSummary),
    relationship_note: "A matching name is a lead to review, not proof of cause. Time overlap alone does not establish a relationship.",
    deployment_change_context: "No deployment/change events were queried; do not attribute symptoms to a deployment.",
  };
}

function buildSessionActivitySummary(events) {
  return {
    event_count: events.length,
    page_view_count: events.filter((event) => event["characteristics.has_page_summary"] === true).length,
    interaction_count: events.filter((event) => event["characteristics.has_user_interaction"] === true).length,
    error_event_count: events.filter((event) => event["characteristics.has_error"] === true).length,
    recent_activity: events.slice(0, 30).map((event) => ({
      timestamp: event.timestamp,
      frontend: event["frontend.name"],
      page: event["page.url.path"],
      interaction: event["interaction.name"],
      error_type: event["error.type"],
      error: event["error.display_name"] || event["exception.message"],
      duration_ms: numericMetric(event, "duration") === null ? null : numericMetric(event, "duration") / 1000000,
    })),
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
  const value = input.id === "session-health"
    ? {
        userIdentifier: String(input.value?.userIdentifier || "").trim().slice(0, 500),
        sessionId: String(input.value?.sessionId || "").trim().slice(0, 200),
      }
    : String(input.value || "").trim().slice(0, 500);
  const hasInput = typeof value === "string" ? Boolean(value) : Boolean(value.userIdentifier || value.sessionId);
  if (definition.requiresInput && !hasInput) throw new Error("Enter a user identifier/tag or session ID.");
  if (definition.requiresConsent && input.consent !== true) throw new Error("Confirm permission before sending the user tag for analysis.");
  if (definition.options && !definition.options.includes(value)) throw new Error("Select a symptom from the list.");
  return {
    question: definition.question(value),
    hints: definition.hints,
    value,
  };
}

async function querySessionHealth(creds, question, workflow, emit) {
  const { userIdentifier, sessionId } = workflow.value;
  const sessionLookback = sessionId ? "30d" : "7d";
  const filters = [];
  if (userIdentifier) {
    filters.push(`matchesValue(user.identifier, ${JSON.stringify(userIdentifier)})`);
  }
  if (sessionId) filters.push(`dt.rum.session.id == ${JSON.stringify(sessionId)}`);

  const sessionDql = "fetch user.sessions\n" +
    '| filter dt.system.bucket != "default_synthetic_user_sessions"\n' +
    `| filter ${filters.join(" or ")}\n` +
    "| sort start_time desc\n" +
    "| limit 1000\n" +
    "| fields dt.rum.session.id, start_time, user.identifier = coalesce(user.identifier, dt.rum.user_tag), " +
    "frontend.name, geo.country.name, geo.city.name, characteristics.has_replay, browser.name, " +
    "duration = toDouble(duration), navigation_count, user_interaction_count, app.version, dt.rum.user_type, " +
    "error.count, request_count, page_summary_count, user_action_count, characteristics.is_bounce";

  emit({ type: "progress", message: "Looking up matching session records..." });
  const timeframeStart = new Date(Date.now() - (sessionId ? 30 : 7) * 24 * 60 * 60 * 1000).toISOString();
  const sessionRecords = await runDql(creds, sessionDql, 1000, timeframeStart);
  const tagMatches = (record) => [record["user.identifier"], record["dt.rum.user_tag"]]
    .some((value) => String(value || "").toLowerCase() === userIdentifier.toLowerCase());
  const tagMatchedRecords = userIdentifier ? sessionRecords.filter(tagMatches) : [];
  const sessionMatchedRecords = sessionId
    ? sessionRecords.filter((record) => record["dt.rum.session.id"] === sessionId)
    : [];
  const sameSessionMatches = userIdentifier && sessionId
    ? sessionRecords.filter((record) => tagMatches(record) && record["dt.rum.session.id"] === sessionId)
    : [];
  const candidateRecords = userIdentifier && sessionId
    ? [...tagMatchedRecords, ...sessionMatchedRecords]
    : sessionId ? sessionMatchedRecords : tagMatchedRecords;
  const uniqueCandidateRecords = [...new Map(candidateRecords
    .filter((record) => record["dt.rum.session.id"])
    .map((record) => [record["dt.rum.session.id"], record])).values()];
  const recordsForDetails = userIdentifier && sessionId && sameSessionMatches.length
    ? sameSessionMatches
    : uniqueCandidateRecords;

  const allSessionIds = [...new Set([
    ...recordsForDetails.map((record) => record["dt.rum.session.id"]),
    ...(sessionId ? [sessionId] : []),
  ].filter(Boolean))];
  const eventSessionIds = allSessionIds.slice(0, 100);
  const eventFilter = eventSessionIds.length
    ? eventSessionIds.map((id) => `dt.rum.session.id == ${JSON.stringify(id)}`).join(" or ")
    : userIdentifier
    ? `user.identifier == ${JSON.stringify(userIdentifier)} or dt.rum.user_tag == ${JSON.stringify(userIdentifier)}`
    : "";

  let eventDql = "";
  let eventRecords = [];
  let eventQueryError = null;
  if (eventFilter) {
    emit({ type: "progress", message: "Retrieving page, interaction, and error activity..." });
    eventDql = "fetch user.events\n" +
      `| filter ${eventFilter}\n` +
      "| fields timestamp, dt.rum.session.id, frontend.name, user.identifier, dt.rum.user_tag, " +
      "characteristics.has_page_summary, characteristics.has_user_interaction, characteristics.has_error, " +
      "page.url.path, interaction.name, error.type, error.display_name, exception.message, exception.type, duration\n" +
      "| sort timestamp desc\n" +
      "| limit 1000";
    try {
      eventRecords = await runDql(creds, eventDql, 1000, timeframeStart);
      if (eventSessionIds.length) {
        const allowedSessionIds = new Set(eventSessionIds);
        eventRecords = eventRecords.filter((event) => allowedSessionIds.has(event["dt.rum.session.id"]));
      } else if (userIdentifier) {
        eventRecords = eventRecords.filter((event) =>
          [event.user_identifier, event["user.identifier"], event["dt.rum.user_tag"]]
            .some((value) => String(value || "").toLowerCase() === userIdentifier.toLowerCase())
        );
      }
    } catch (err) {
      eventQueryError = err.message;
    }
  }

  const eventsBySession = new Map();
  for (const event of eventRecords) {
    const id = event["dt.rum.session.id"];
    if (!id) continue;
    if (!eventsBySession.has(id)) eventsBySession.set(id, []);
    eventsBySession.get(id).push(event);
  }
  const eventTagMatches = userIdentifier && eventRecords.some((event) =>
    [event.user_identifier, event["user.identifier"], event["dt.rum.user_tag"]]
      .some((value) => String(value || "").toLowerCase() === userIdentifier.toLowerCase())
  );

  const matchStatus = eventQueryError && !sessionRecords.length
    ? "query_failed"
    : userIdentifier && sessionId
    ? sameSessionMatches.length || eventTagMatches && eventsBySession.has(sessionId)
      ? "both_identifiers_matched"
      : uniqueCandidateRecords.length || eventRecords.length ? "identifiers_do_not_match_same_session" : "no_matching_records"
    : userIdentifier
    ? tagMatchedRecords.length || eventTagMatches ? "user_identifier_matched_all_sessions" : "no_matching_records"
    : sessionMatchedRecords.length || eventsBySession.has(sessionId) ? "session_id_matched" : "no_matching_records";
  const sessionDetails = recordsForDetails.map((record) => {
    const id = record["dt.rum.session.id"];
    return {
      record_type: "session",
      session_id: id,
      start_time: record.start_time,
      end_time: record.end_time,
      user_identifier: record["user.identifier"] || record["dt.rum.user_tag"],
      frontend_names: record.frontend_name || record["frontend.name"],
      duration_ns: numericMetric(record, "duration"),
      error_count: numericMetric(record, "error.count"),
      navigation_count: numericMetric(record, "navigation_count"),
      user_interaction_count: numericMetric(record, "user_interaction_count"),
      user_action_count: numericMetric(record, "user_action_count"),
      request_count: numericMetric(record, "request_count"),
      page_summary_count: numericMetric(record, "page_summary_count"),
      view_summary_count: numericMetric(record, "view_summary_count"),
      browser: record["browser.name"],
      device: record["device.type"],
      os: record["os.name"],
      event_activity: buildSessionActivitySummary(eventsBySession.get(id) || []),
    };
  });
  const eventOnlySessions = [...eventsBySession.entries()]
    .filter(([id]) => !recordsForDetails.some((record) => record["dt.rum.session.id"] === id))
    .map(([id, events]) => ({
      record_type: "event-only-session",
      session_id: id,
      event_activity: buildSessionActivitySummary(events),
    }));
  const matchedCount = userIdentifier && sessionId
    ? sameSessionMatches.length || (eventTagMatches && eventsBySession.has(sessionId) ? 1 : 0)
    : userIdentifier ? tagMatchedRecords.length || eventOnlySessions.length : sessionMatchedRecords.length || eventOnlySessions.length;
  const matchedFrontendNames = [...new Set([
    ...recordsForDetails.flatMap((record) => {
      const names = record.frontend_name || record["frontend.name"];
      return Array.isArray(names) ? names.flat(Infinity).filter(Boolean) : names ? [names] : [];
    }),
    ...eventRecords.map((event) => event["frontend.name"]).flat(Infinity).filter(Boolean),
  ].map((name) => String(name).toLowerCase()))];

  const summary = {
    record_type: "session-lookup-summary",
    requested_user_identifier: userIdentifier || null,
    requested_session_id: sessionId || null,
    match_status: matchStatus,
    matching_session_count: matchedCount,
    user_identifier_match_count: tagMatchedRecords.length || (eventTagMatches ? eventOnlySessions.length : 0),
    session_id_match_count: sessionMatchedRecords.length || (sessionId && eventsBySession.has(sessionId) ? 1 : 0),
    same_session_match_count: sameSessionMatches.length || (eventTagMatches && sessionId && eventsBySession.has(sessionId) ? 1 : 0),
    session_window: sessionLookback,
    session_results_truncated: sessionRecords.length >= 500,
    event_sessions_queried: eventSessionIds.length,
    event_sessions_truncated: allSessionIds.length > eventSessionIds.length,
    session_query_status: "queried",
    event_query_status: eventQueryError ? "failed" : eventFilter ? "queried" : "not_run",
    event_query_error: eventQueryError,
    session_assessment_note: sessionDetails.length || eventOnlySessions.length
      ? "Each matched session is listed separately. Tag-only mode includes all matching sessions in the stated window, subject to the query limit."
      : "No matching session record or event activity was found for the supplied identifiers. This does not establish that the user was unaffected.",
  };

  const frontendMetrics = matchedFrontendNames.length
    ? await (async () => {
        const current = await runDql(creds, FRONTEND_HEALTH_METRICS_DQL);
        const previous = await runDql(creds, FRONTEND_HEALTH_PREVIOUS_METRICS_DQL);
        const previousByName = new Map(previous.map((record) => [String(record["frontend.name"] || "").toLowerCase(), record]));
        return current
          .filter((record) => matchedFrontendNames.includes(String(record["frontend.name"] || "").toLowerCase()))
          .map((record) => compactFrontendMetricSummary(summarizeFrontendMetricTrend(
            record,
            previousByName.get(String(record["frontend.name"] || "").toLowerCase())
          )));
      })()
    : [];
  const records = [summary, ...sessionDetails, ...eventOnlySessions];
  if (frontendMetrics.length) records.push({ record_type: "session_frontend_metrics", frontends: frontendMetrics });
  const dql = eventDql ? `${sessionDql}\n\n${eventDql}` : sessionDql;
  return { dql, recordCount: records.length, supplementary: buildSupplementary(question, dql, records) };
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
    if (workflow?.id === "session-health") {
      emit({ type: "progress", message: "Checking the supplied user identifier and session ID..." });
      return await querySessionHealth(creds, question, workflow, emit);
    }
    if (workflow) {
      emit({ type: "progress", message: "Querying frontend errors and page performance..." });
      dql = `${FRONTEND_HEALTH_METRICS_DQL}\n\n${FRONTEND_HEALTH_PREVIOUS_METRICS_DQL}`;
      const metricRecords = await runDql(creds, FRONTEND_HEALTH_METRICS_DQL);
      const previousMetricRecords = await runDql(creds, FRONTEND_HEALTH_PREVIOUS_METRICS_DQL);
      let davisProblems = [];
      let davisProblemQueryError = null;
      try {
        davisProblems = await runDql(creds, FRONTEND_PROBLEMS_DQL, 50);
      } catch (err) {
        davisProblemQueryError = err.message;
      }
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
        const davisProblemContext = buildDavisProblemContext(davisProblems, workflow.value, davisProblemQueryError);
        records = match
          ? [{ ...match, davis_problem_context: davisProblemContext }]
          : metricRecords.length
          ? [{
              requested_frontend: workflow.value,
              metric_series_found: false,
              health_status: "inconclusive",
              health_reasons: ["No metric series was returned for the selected frontend in the analyzed period."],
              available_frontends: summaries.map((summary) => summary.frontend_name).slice(0, 50),
              davis_problem_context: davisProblemContext,
            }]
          : [{
              requested_frontend: workflow.value,
              metric_series_found: false,
              health_status: "inconclusive",
              health_reasons: ["The frontend metrics query returned no series; health cannot be assessed."],
              davis_problem_context: davisProblemContext,
            }];
      } else if (workflow.id === "session-health") {
        const { userIdentifier, sessionId } = workflow.value;
        emit({ type: "progress", message: "Checking the user identifier and session ID..." });
        const sessionFilters = [];
        if (userIdentifier) {
          sessionFilters.push(`user.identifier == ${JSON.stringify(userIdentifier)}`);
          sessionFilters.push(`dt.rum.user_tag == ${JSON.stringify(userIdentifier)}`);
        }
        if (sessionId) sessionFilters.push(`dt.rum.session.id == ${JSON.stringify(sessionId)}`);
        const sessionLookback = sessionId ? "30d" : "7d";
        const sessionDql = `fetch user.sessions, from:now()-${sessionLookback}, to:now()\n` +
          '| filter dt.system.bucket != "default_synthetic_user_sessions"\n' +
          `| filter ${sessionFilters.join(" or ")}\n` +
          "| sort start_time desc\n" +
          "| limit 500\n" +
          "| fields dt.rum.session.id, start_time, end_time, user.identifier, dt.rum.user_tag, frontend.name, " +
          "duration = toDouble(duration), error.count, navigation_count, user_interaction_count, user_action_count, " +
          "request_count, page_summary_count, view_summary_count, browser.name, device.type, os.name";
        dql += `\n\n${sessionDql}`;
        let sessionRecords = [];
        let sessionQueryError = null;
        try {
          sessionRecords = await runDql(creds, sessionDql, 500);
        } catch (err) {
          sessionQueryError = err.message;
        }
        const tagMatches = (record) => [record["user.identifier"], record["dt.rum.user_tag"]]
          .some((value) => String(value || "").toLowerCase() === userIdentifier.toLowerCase());
        const tagMatchedRecords = userIdentifier ? sessionRecords.filter(tagMatches) : [];
        const sessionMatchedRecords = sessionId
          ? sessionRecords.filter((record) => record["dt.rum.session.id"] === sessionId)
          : [];
        const sameSessionMatches = userIdentifier && sessionId
          ? sessionRecords.filter((record) => tagMatches(record) && record["dt.rum.session.id"] === sessionId)
          : [];
        const relevantSessionRecords = userIdentifier && sessionId
          ? sameSessionMatches
          : sessionId ? sessionMatchedRecords : tagMatchedRecords;

        const eventSessionIds = [...new Set((sessionId
          ? [sessionId]
          : relevantSessionRecords.map((record) => record["dt.rum.session.id"])
        ).filter(Boolean))].slice(0, 50);
        let sessionEventRecords = [];
        let sessionEventQueryError = null;
        let sessionEventsDql = "";
        const eventFilter = eventSessionIds.length
          ? eventSessionIds.map((id) => `dt.rum.session.id == ${JSON.stringify(id)}`).join(" or ")
          : userIdentifier
          ? `user.identifier == ${JSON.stringify(userIdentifier)} or dt.rum.user_tag == ${JSON.stringify(userIdentifier)}`
          : "";
        if (eventFilter) {
          sessionEventsDql = `fetch user.events, from:now()-${sessionLookback}, to:now()\n` +
            `| filter ${eventFilter}\n` +
            "| fields timestamp, dt.rum.session.id, frontend.name, dt.rum.user_tag, characteristics.has_page_summary, " +
            "user.identifier, characteristics.has_user_interaction, characteristics.has_error, page.url.path, interaction.name, " +
            "error.type, error.display_name, exception.message, exception.type, duration\n" +
            "| sort timestamp desc\n" +
            "| limit 1000";
          dql += `\n\n${sessionEventsDql}`;
          try {
            sessionEventRecords = await runDql(creds, sessionEventsDql, 1000);
          } catch (err) {
            sessionEventQueryError = err.message;
          }
        }

        const matchedFrontendNames = [...new Set(relevantSessionRecords.flatMap((record) => {
          const names = record.frontend_name || record["frontend.name"];
          return Array.isArray(names) ? names.flat(Infinity).filter(Boolean) : names ? [names] : [];
        }).map((name) => String(name).toLowerCase()))];
        const matchStatus = sessionQueryError
          ? "session_query_failed"
          : !sessionRecords.length
          ? "no_matching_records"
          : userIdentifier && sessionId && !sameSessionMatches.length
          ? "identifiers_do_not_match_same_session"
          : userIdentifier && sessionId
          ? "both_identifiers_matched"
          : sessionId
          ? "session_id_matched"
          : "user_identifier_matched";
        records = [{
          requested_user_identifier: userIdentifier || null,
          requested_session_id: sessionId || null,
          match_status: matchStatus,
          user_identifier_match_count: tagMatchedRecords.length,
          session_id_match_count: sessionMatchedRecords.length,
          same_session_match_count: sameSessionMatches.length,
          session_records: relevantSessionRecords,
          session_query_error: sessionQueryError,
          event_activity: buildSessionActivitySummary(sessionEventRecords),
          event_query_error: sessionEventQueryError,
          session_results_truncated: sessionRecords.length >= 500,
          event_sessions_queried: eventSessionIds.length,
          event_lookup_truncated: new Set([...relevantSessionRecords.map((record) => record["dt.rum.session.id"]), ...(sessionId ? [sessionId] : [])].filter(Boolean)).size > eventSessionIds.length,
          session_assessment_note: relevantSessionRecords.length || sessionEventRecords.length
            ? `All matching session records within ${sessionLookback} are shown, up to the query limit. Event activity may be present even when the finalized session aggregate is not.`
            : "No matching session record or event activity was found for the supplied identifiers in the queried windows. This does not establish that the user was unaffected.",
          session_frontend_metrics: summaries
            .filter((summary) => matchedFrontendNames.includes(summary.frontend_name.toLowerCase()))
            .map(compactFrontendMetricSummary),
          ...(relevantSessionRecords.length ? {
            davis_problem_context: buildDavisProblemContext(davisProblems, null, davisProblemQueryError),
          } : {}),
        }];
      } else {
        records = [{
          workflow: workflow.id,
          ...(workflow.id === "impact-scope" ? { reported_symptom: workflow.value } : {}),
          ...prioritizeFrontendMetrics(summaries),
          davis_problem_context: buildDavisProblemContext(davisProblems, null, davisProblemQueryError),
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

  ipcMain.handle("chat:export-pdf", async (_event, input) => {
    const messages = (Array.isArray(input?.messages) ? input.messages : [])
      .slice(-200)
      .filter((message) => message && ["user", "assistant", "error"].includes(message.role))
      .map((message) => ({
        role: message.role,
        text: String(message.text || "").slice(0, 30000),
        timestamp: String(message.timestamp || ""),
      }))
      .filter((message) => message.text.trim());
    if (!messages.length) throw new Error("There is no chat content to export.");

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: "Export On-call Chat",
      defaultPath: path.join(app.getPath("downloads"), `Dynatrace-OnCall-Case-${new Date().toISOString().slice(0, 10)}.pdf`),
      filters: [{ name: "PDF document", extensions: ["pdf"] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

    const pdfWindow = new BrowserWindow({
      width: 900,
      height: 1200,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try {
      await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildPdfHtml(messages))}`);
      const pdf = await pdfWindow.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      });
      fs.writeFileSync(saveResult.filePath, pdf);
      return { canceled: false, filePath: saveResult.filePath };
    } finally {
      if (!pdfWindow.isDestroyed()) pdfWindow.close();
    }
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

"use strict";

const api = window.answers;
const $ = (id) => document.getElementById(id);

const els = {
  messages: $("messages"),
  emptyState: $("emptyState"),
  promptBar: $("promptBar"),
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  newChatBtn: $("newChatBtn"),
  exportPdfBtn: $("exportPdfBtn"),
  settingsBtn: $("settingsBtn"),
  helpBtn: $("helpBtn"),
  helpOverlay: $("helpOverlay"),
  helpContent: $("helpContent"),
  helpTopics: $("helpTopics"),
  closeHelpBtn: $("closeHelpBtn"),
  downloadUserGuideBtn: $("downloadUserGuideBtn"),
  guideDownloadStatus: $("guideDownloadStatus"),
  status: $("connectionStatus"),
  appVersion: $("appVersion"),
  workflowOverlay: $("workflowOverlay"),
  workflowForm: $("workflowForm"),
  workflowTitle: $("workflowTitle"),
  workflowLabel: $("workflowLabel"),
  workflowInput: $("workflowInput"),
  workflowSelect: $("workflowSelect"),
  frontendPicker: $("frontendPicker"),
  frontendOptions: $("frontendOptions"),
  frontendStatus: $("frontendStatus"),
  workflowRunBtn: $("workflowRunBtn"),
  sessionConsentRow: $("sessionConsentRow"),
  sessionConsent: $("sessionConsent"),
  sessionIdRow: $("sessionIdRow"),
  sessionIdInput: $("sessionIdInput"),
  overlay: $("settingsOverlay"),
  tenantUrl: $("tenantUrl"),
  token: $("token"),
  tokenHint: $("tokenHint"),
  dataMode: $("dataMode"),
  testBtn: $("testBtn"),
  testResult: $("testResult"),
  saveBtn: $("saveSettingsBtn"),
  cancelBtn: $("cancelSettingsBtn"),
  closeBtn: $("closeSettingsBtn"),
  saveError: $("saveError"),
};

let settings = { tenantUrl: "", hasToken: false };
let conversationState = null;
let busy = false;
let activeRequest = null;
let activeWorkflow = null;
let frontendNames = [];
let filteredFrontends = [];
let selectedFrontend = null;
let activeFrontendIndex = -1;
let hostNames = [];
let selectedHosts = new Map();
let hostLoadId = 0;
let activeCategory = "Overview";
let helpReturnFocus = null;
let guideLoaded = false;
let guideLoading = false;
let tooltipButton = null;
let tooltipOriginalTitle = null;
let tooltipOriginalDescription = null;

const FRONTEND_ACTIONS = [
  { id: "infra-health", label: "Infra Health", category: "Infrastructure", inputLabel: "Hosts", placeholder: "Search hosts..." },
  { id: "website-health", label: "Website health", inputLabel: "Frontend application", placeholder: "Application name" },
  { id: "system-health", label: "All websites health" },
  { id: "guided-triage", label: "Guided triage", category: "Investigate", inputLabel: "Reported symptom", placeholder: "What did the caller report?" },
  { id: "session-health", label: "Session health", category: "Investigate", inputLabel: "User identifier or tag (optional)", placeholder: "e.g. maria", requiresConsent: true },
  {
    id: "impact-scope",
    label: "Impact scope",
    category: "Investigate",
    inputLabel: "Reported symptom",
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
  },
  { id: "frontend-errors", label: "Frontend errors" },
  { id: "slow-pages", label: "Slow pages" },
  ...window.healthChecks.OPERATIONAL_ACTIONS,
];

const OVERVIEW_ACTIONS = ["overall-health", "active-incidents", "website-health", "backend-health", "database-health", "infra-health", "guided-triage", "application-health"];

function setStatus(kind, text) {
  els.status.className = `status status-${kind}`;
  els.status.textContent = text;
}

function isConfigured() {
  return Boolean(settings.tenantUrl && settings.hasToken);
}

function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function setBusy(value) {
  busy = value;
  els.sendBtn.disabled = value;
  els.newChatBtn.disabled = value;
  updateExportButton();
  els.promptBar.querySelectorAll("button").forEach((b) => (b.disabled = value));
}

function updateExportButton() {
  els.exportPdfBtn.disabled = busy || !els.messages.querySelector(".msg-user, .msg-ai, .msg-error");
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessage(kind, content) {
  els.emptyState.classList.add("hidden");
  const div = document.createElement("div");
  div.className = `msg msg-${kind}`;
  div.dataset.timestamp = new Date().toISOString();
  if (content !== undefined) div.textContent = content;
  els.messages.appendChild(div);
  updateExportButton();
  scrollToBottom();
  return div;
}

function sanitizeAnswer(text) {
  const cleaned = String(text || "")
    .replace(/If you want help with creating DQL queries,\s*ask your admin to enable Agentic AI\.?/gi, "")
    .replace(/\n{3,}/g, "\n\n");
  const output = [];
  let skipLimitations = false;
  let skipDirections = false;

  for (const line of cleaned.split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    const boldHeading = line.match(/^\s*\*\*(.+?)\*\*\s*:??\s*$/);
    const headingText = heading?.[1] || boldHeading?.[1] || null;
    const isHeading = Boolean(heading || boldHeading);
    if (skipLimitations) {
      if (!isHeading) continue;
      skipLimitations = false;
    }
    if (headingText && /^data limitations?\b/i.test(headingText)) {
      skipLimitations = true;
      continue;
    }

    if (/^\s*(?:(?:[-*+]\s+|\d+[.)]\s+))?(?:\*\*)?(?:to (?:retrieve|assess|find|view|locate)\b|what you need(?: instead)?\b|how to find this information\b|via the dynatrace ui\b|(?:go|navigate) to .*(?:dynatrace|users\s*&\s*sessions)|(?:open|review) .*(?:dynatrace|session viewer))/i.test(line)) {
      skipDirections = true;
      continue;
    }
    if (skipDirections) {
      if (!line.trim() || /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) continue;
      skipDirections = false;
    }
    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatSessionTime(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function openSessionAnalysis(sessionId, userIdentifier) {
  const action = FRONTEND_ACTIONS.find((item) => item.id === "session-health");
  if (!action || !sessionId) return;
  startWorkflow(action);
  els.workflowInput.value = userIdentifier || "";
  els.sessionIdInput.value = sessionId;
  els.sessionConsent.checked = false;
  els.workflowRunBtn.disabled = true;
  els.sessionIdInput.focus();
}

function createSessionIdButton(sessionId, userIdentifier) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-id-link";
  button.textContent = sessionId;
  button.title = "Analyze this session";
  button.addEventListener("click", () => openSessionAnalysis(sessionId, userIdentifier));
  return button;
}

function appendSessionMetric(list, label, value) {
  const item = document.createElement("li");
  const term = document.createElement("strong");
  term.textContent = `${label}: `;
  const description = document.createElement("span");
  description.textContent = value === null || value === undefined || value === "" ? "Not available" : String(value);
  item.append(term, description);
  list.appendChild(item);
}

function renderSessionReport(container, report) {
  const section = document.createElement("section");
  section.className = "session-report";
  const summary = report.summary || {};
  const heading = document.createElement("h3");
  heading.textContent = "Session Summary";
  section.appendChild(heading);

  const overview = document.createElement("p");
  overview.textContent = summary.match_status === "user_identifier_matched_all_sessions"
    ? `Found ${summary.matching_session_count ?? 0} sessions for ${summary.requested_user_identifier || "the selected user"} in ${summary.session_window || "the queried period"}.`
    : summary.match_status === "no_matching_records"
    ? `No sessions matched ${summary.requested_user_identifier || summary.requested_session_id || "the supplied identifiers"} in ${summary.session_window || "the queried period"}. No session-specific health conclusion can be made.`
    : summary.match_status === "identifiers_do_not_match_same_session"
    ? "The user identifier and session ID did not resolve to the same session. Review the matching records below before drawing a conclusion."
    : `Session lookup status: ${summary.match_status || "unknown"}.`;
  section.appendChild(overview);

  const totals = document.createElement("ul");
  totals.className = "session-summary-list";
  appendSessionMetric(totals, "Sessions returned", summary.sessions_returned ?? summary.matching_session_count);
  appendSessionMetric(totals, "Sessions with errors", summary.sessions_with_errors);
  appendSessionMetric(totals, "Total session errors", summary.total_session_errors);
  if (summary.session_results_truncated) appendSessionMetric(totals, "Coverage", "At least 500 matching sessions; list is capped");
  section.appendChild(totals);

  const newest = report.mostRecentSession || summary.most_recent_session_deep_dive;
  if (newest) {
    const deepDiveTitle = document.createElement("h4");
    deepDiveTitle.textContent = "Most Recent Session";
    section.appendChild(deepDiveTitle);
    const deepDive = document.createElement("ul");
    deepDive.className = "session-summary-list";
    const idItem = document.createElement("li");
    const idLabel = document.createElement("strong");
    idLabel.textContent = "Session ID: ";
    idItem.append(idLabel, createSessionIdButton(newest.session_id, newest.user_identifier || summary.requested_user_identifier));
    deepDive.appendChild(idItem);
    appendSessionMetric(deepDive, "User tag", newest.user_identifier || summary.requested_user_identifier);
    appendSessionMetric(deepDive, "Started", formatSessionTime(newest.start_time));
    appendSessionMetric(deepDive, "Frontend", Array.isArray(newest.frontend_names) ? newest.frontend_names.join(", ") : newest.frontend_names);
    appendSessionMetric(deepDive, "Errors", newest.error_count);
    appendSessionMetric(deepDive, "Navigations", newest.navigation_count);
    appendSessionMetric(deepDive, "Page views", newest.page_summary_count);
    appendSessionMetric(deepDive, "User actions", newest.user_action_count);
    appendSessionMetric(deepDive, "Requests", newest.request_count);
    appendSessionMetric(deepDive, "Duration (ns)", newest.duration_ns);
    if (newest.event_activity) {
      appendSessionMetric(deepDive, "Events", newest.event_activity.event_count);
      appendSessionMetric(deepDive, "Event errors", newest.event_activity.error_event_count);
    }
    section.appendChild(deepDive);
  }

  const latestFive = report.latestFiveSessions || summary.latest_five_sessions || [];
  if (latestFive.length) {
    const listTitle = document.createElement("h4");
    listTitle.textContent = "Five Most Recent Sessions";
    section.appendChild(listTitle);

    const tableWrap = document.createElement("div");
    tableWrap.className = "session-table-wrap";
    const table = document.createElement("table");
    table.className = "session-table";
    const header = document.createElement("tr");
    ["Session ID", "User tag", "Started", "Frontend", "Errors", "Navigations", "Actions", "Requests"].forEach((label) => {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      header.appendChild(cell);
    });
    const thead = document.createElement("thead");
    thead.appendChild(header);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    latestFive.forEach((session) => {
      const row = document.createElement("tr");
      const idCell = document.createElement("td");
      idCell.appendChild(createSessionIdButton(session.session_id, session.user_identifier || summary.requested_user_identifier));
      row.appendChild(idCell);
      const frontend = Array.isArray(session.frontend_names) ? session.frontend_names.join(", ") : session.frontend_names;
      [session.user_identifier || summary.requested_user_identifier, formatSessionTime(session.start_time), frontend, session.error_count, session.navigation_count, session.user_action_count, session.request_count].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);
  }

  container.appendChild(section);
}

function hostAnalysisLink(host) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "host-link";
  button.textContent = host.name;
  button.title = `Analyze CPU and memory for ${host.name} (${host.id})`;
  button.addEventListener("click", () => sendPrompt("Infra Health", { id: "infra-health", value: [host] }, `Infra Health: ${host.name}`));
  return button;
}

function formatPercent(value) {
  return value === null || value === undefined ? "Not available" : `${Number(value).toFixed(1)}%`;
}

function appendInfraTable(section, title, headers, rows) {
  const heading = document.createElement("h4");
  heading.textContent = title;
  const wrap = document.createElement("div");
  wrap.className = "session-table-wrap";
  const table = document.createElement("table");
  table.className = "session-table infra-table";
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  headers.forEach((text) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = text;
    header.appendChild(cell);
  });
  head.appendChild(header);
  const body = document.createElement("tbody");
  rows.forEach((values) => {
    const row = document.createElement("tr");
    values.forEach((value) => {
      const cell = document.createElement("td");
      if (value instanceof Node) cell.appendChild(value);
      else cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  table.append(head, body);
  wrap.appendChild(table);
  section.append(heading, wrap);
}

function renderInfraReport(container, report) {
  const section = document.createElement("section");
  section.className = "session-report";
  const heading = document.createElement("h3");
  heading.textContent = report.detail ? "Host CPU & Memory Analysis" : "Infrastructure CPU & Memory Summary";
  const overview = document.createElement("p");
  const scope = Array.isArray(report.scope) ? `${report.scope.length} selected host(s)` : "All hosts";
  overview.textContent = `${scope} | ${report.window} | ${formatSessionTime(report.generatedAt)}. ` +
    (report.hostCount ? `${report.hostCount} hosts with telemetry; ${report.issueHostCount} with average or peak utilization >=80%.` : "No usable host telemetry returned; CPU and memory health is inconclusive.");
  const thresholds = document.createElement("p");
  thresholds.className = "muted small";
  thresholds.textContent = `${report.thresholds} Ranked by average utilization. CPU coverage: ${report.cpuCount} hosts; memory coverage: ${report.memoryCount} hosts.`;
  section.append(heading, overview, thresholds);
  const warnings = [...report.errors];
  if (report.incompleteHostCount) warnings.push(`${report.incompleteHostCount} hosts lack usable CPU or memory readings. Their health is inconclusive.`);
  if (report.capped) warnings.push("Result cap reached. Rankings are per resource; fleet counts are lower bounds and coverage may be incomplete.");
  if (report.missingHosts.length) warnings.push(`No telemetry for: ${report.missingHosts.map((host) => host.name).join(", ")}.`);
  warnings.forEach((text) => {
    const warning = document.createElement("p");
    warning.className = "error-text";
    warning.textContent = text;
    section.appendChild(warning);
  });
  for (const [title, rows] of [["Top 10 Hosts - CPU", report.topCpu], ["Top 10 Hosts - Memory", report.topMemory]]) {
    if (rows.length) appendInfraTable(section, title, ["Host", "Average", "Peak", "Assessment"], rows.map((row) => [hostAnalysisLink(row), formatPercent(row.average), formatPercent(row.peak), row.status]));
    else {
      const empty = document.createElement("p");
      empty.textContent = `${title}: no usable readings.`;
      section.appendChild(empty);
    }
  }
  if (report.selected.length > 1) {
    appendInfraTable(section, "Selected Hosts", ["Host", "CPU avg", "CPU peak", "Memory avg", "Memory peak"], report.selected.map((host) => [hostAnalysisLink(host), formatPercent(host.cpu?.average), formatPercent(host.cpu?.peak), formatPercent(host.memory?.average), formatPercent(host.memory?.peak)]));
  }
  if (report.detail) {
    appendInfraTable(section, "Two-Hour Comparison", ["Resource", "Previous avg", "Latest 5m avg", "5m buckets >=80%", "5m buckets >=90%", "Missing buckets"], ["cpu", "memory"].map((metric) => {
      const detail = report.detail[metric];
      const current = detail.current;
      return [metric === "cpu" ? "CPU" : "Memory", formatPercent(detail.previous?.average), formatPercent(current?.latest), current ? `${current.warningBuckets}/${current.observedBuckets}` : "Not available", current ? `${current.criticalBuckets}/${current.observedBuckets}` : "Not available", current ? String(current.missingBuckets) : "Not available"];
    }));
    const cpu = report.detail.cpu.current;
    const memory = report.detail.memory.current;
    const samples = Math.max(cpu?.samples.length || 0, memory?.samples.length || 0);
    if (samples) {
      const start = new Date(cpu?.timeframe?.start || memory?.timeframe?.start).getTime();
      appendInfraTable(section, "Five-Minute Readings", ["Bucket start", "CPU avg", "Memory avg"], Array.from({ length: samples }, (_, index) => [Number.isFinite(start) ? formatSessionTime(start + index * 300000) : `Bucket ${index + 1}`, formatPercent(cpu?.samples[index]), formatPercent(memory?.samples[index])]));
    }
  }
  container.appendChild(section);
}

function renderOperationalReport(container, report) {
  const section = document.createElement("section");
  section.className = "session-report operational-report";
  const heading = document.createElement("h3");
  heading.textContent = report.title;
  const status = document.createElement("p");
  status.className = `operational-status ${report.status === "Critical" ? "error-text" : report.status === "Needs attention" ? "warn-text" : ""}`;
  status.textContent = `Status: ${report.status}${report.coverageIncomplete ? " (coverage incomplete)" : ""}`;
  section.append(heading, status);
  const overview = document.createElement("dl");
  overview.className = "operational-overview";
  const activeStarts = (report.problems || []).filter((problem) => problem["event.status"] === "ACTIVE")
    .map((problem) => new Date(problem["event.start"]).getTime()).filter(Number.isFinite);
  const fields = [
    ["What's affected", report.scope],
    ["Since when", activeStarts.length ? `Earliest recorded active incident: ${formatSessionTime(Math.min(...activeStarts))}` : "Onset not established from the collected evidence"],
    ["Better or worse", report.trend],
    ["Next action", report.nextAction],
    ["Evidence coverage", `${report.sources.filter((source) => source.status === "Available").length}/${report.sources.length} sources returned records; ${report.window}. Checked ${formatSessionTime(report.generatedAt)}.`],
  ];
  fields.forEach(([label, value]) => {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    overview.append(term, description);
  });
  section.appendChild(overview);
  report.sections.forEach((item) => {
    const details = document.createElement("details");
    details.className = "evidence-section";
    details.open = item.rows.length > 0 && item.rows.length <= 10;
    const summary = document.createElement("summary");
    summary.textContent = `${item.title} (${item.rows.length})`;
    details.appendChild(summary);
    if (item.rows.length) {
      appendInfraTable(details, item.title, item.columns, item.rows.map((row) => row.map((value, index) => {
        if (index === 0 && value && (item.title === "Recorded incidents" || item.title === "Backend services")) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "host-link";
          button.textContent = value;
          button.title = item.title === "Recorded incidents" ? "Summarize this incident" : "Check this service";
          button.addEventListener("click", () => sendPrompt(button.title, { id: item.title === "Recorded incidents" ? "incident-summary" : "backend-health", value }, `${button.title}: ${value}`));
          return button;
        }
        return typeof value === "number" ? Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "Unknown" : value == null || value === "" ? "Unknown" : String(value);
      })));
    } else {
      const empty = document.createElement("p");
      empty.textContent = "No matching evidence returned. This does not establish healthy operation.";
      details.appendChild(empty);
    }
    section.appendChild(details);
  });
  const coverage = document.createElement("details");
  coverage.className = "evidence-section";
  const coverageTitle = document.createElement("summary");
  coverageTitle.textContent = "Coverage and assessment rules";
  coverage.appendChild(coverageTitle);
  report.notes.forEach((note) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = note;
    coverage.appendChild(paragraph);
  });
  report.sources.forEach((source) => {
    const paragraph = document.createElement("p");
    paragraph.className = source.status === "Unknown" || source.capped ? "warn-text" : "muted";
    paragraph.textContent = `${source.label}: ${source.status}${source.error ? ` - ${source.error}` : ""}${source.capped ? " - result cap reached; coverage incomplete" : ""}.`;
    coverage.appendChild(paragraph);
  });
  section.appendChild(coverage);
  const followups = document.createElement("div");
  followups.className = "report-actions";
  ["is-it-recovering", "what-changed", "incident-summary"].filter((id) => id !== report.id && settings.buttons?.[id] !== false).forEach((id) => {
    const action = FRONTEND_ACTIONS.find((item) => item.id === id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost";
    button.textContent = action.label;
    button.dataset.tooltip = window.answersHelp.BUTTON_HELP[id];
    button.addEventListener("click", () => sendPrompt(action.label, { id, value: report.scope === "Monitored environment" ? "" : report.scope }, `${action.label}: ${report.scope}`));
    followups.appendChild(button);
  });
  section.appendChild(followups);
  container.appendChild(section);
}

function renderAnswer(div, result) {
  div.innerHTML = "";
  if (result.sessionReport || result.infraReport || result.operationalReport) {
    if (result.operationalReport) renderOperationalReport(div, result.operationalReport);
    else if (result.infraReport) renderInfraReport(div, result.infraReport);
    else renderSessionReport(div, result.sessionReport);
    const additional = document.createElement("details");
    additional.className = "assistant-commentary";
    const summary = document.createElement("summary");
    summary.textContent = "Additional analysis";
    const narrative = document.createElement("div");
    narrative.innerHTML = window.renderMarkdown(sanitizeAnswer(result.text) || "_No additional analysis returned._");
    additional.append(summary, narrative);
    div.appendChild(additional);
  } else {
    const narrative = document.createElement("div");
    narrative.innerHTML = window.renderMarkdown(sanitizeAnswer(result.text) || "_No answer returned._");
    div.appendChild(narrative);
  }

  if (result.notifications?.length) {
    const box = document.createElement("div");
    box.className = "notifications";
    result.notifications.forEach((n) => {
      const p = document.createElement("div");
      p.textContent = `${n.severity || "Notice"}: ${String(n.message || "").replace(/https?:\/\/\S+/g, "")}`;
      box.appendChild(p);
    });
    div.appendChild(box);
  }

}

async function sendPrompt(text, workflow = null, displayText = text) {
  const prompt = String(text || "").trim();
  if (!prompt || busy) return;
  if (!isConfigured()) {
    openSettings();
    return;
  }

  addMessage("user", displayText);
  const aiDiv = addMessage("ai");
  aiDiv.innerHTML = '<span class="progress">Thinking...</span>';
  setBusy(true);

  const requestId = crypto.randomUUID();
  activeRequest = { id: requestId, div: aiDiv, text: "" };

  try {
    const result = await api.send({ requestId, text: prompt, state: workflow ? null : conversationState, workflow });
    conversationState = result.state || conversationState;
    renderAnswer(aiDiv, result);
    setStatus("ok", "Connected");
  } catch (err) {
    aiDiv.remove();
    addMessage("error", cleanError(err));
    if (/401|403|token/i.test(cleanError(err))) setStatus("err", "Auth error");
  } finally {
    activeRequest = null;
    setBusy(false);
    scrollToBottom();
    els.input.focus();
  }
}

api.onChatEvent((evt) => {
  if (!activeRequest || evt.requestId !== activeRequest.id) return;
  if (evt.type === "progress" && !activeRequest.text) {
    activeRequest.div.innerHTML = "";
    const span = document.createElement("span");
    span.className = "progress";
    span.textContent = evt.message || "Working...";
    activeRequest.div.appendChild(span);
  } else if (evt.type === "tokens") {
    activeRequest.text += evt.text;
    activeRequest.div.innerHTML = window.renderMarkdown(sanitizeAnswer(activeRequest.text));
  }
  scrollToBottom();
});

function renderPromptBar() {
  els.promptBar.innerHTML = "";
  const enabled = FRONTEND_ACTIONS.filter((action) => settings.buttons?.[action.id] !== false);
  const categories = ["Overview", "Frontend", "Backend", "Infrastructure", "Investigate"].filter((category) => enabled.some((action) => category === "Overview" ? OVERVIEW_ACTIONS.includes(action.id) : (action.category || "Frontend") === category));
  if (!categories.includes(activeCategory)) activeCategory = categories[0] || "Overview";
  const tabs = document.createElement("div");
  tabs.className = "check-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Health check categories");
  categories.forEach((category, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = `check-tab-${category}`;
    tab.className = "check-tab";
    tab.textContent = category;
    tab.dataset.tooltip = `Show ${category.toLowerCase()} checks. Choose a check to collect its specific evidence.`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(category === activeCategory));
    tab.setAttribute("aria-controls", "checkPanel");
    tab.tabIndex = category === activeCategory ? 0 : -1;
    tab.disabled = busy;
    const select = (next) => { activeCategory = next; renderPromptBar(); document.getElementById(`check-tab-${next}`)?.focus(); };
    tab.addEventListener("click", () => select(category));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + categories.length) % categories.length;
      select(categories[next]);
    });
    tabs.appendChild(tab);
  });
  const panel = document.createElement("div");
  panel.id = "checkPanel";
  panel.className = "check-panel";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", `check-tab-${activeCategory}`);
  const actions = activeCategory === "Overview" ? OVERVIEW_ACTIONS.map((id) => enabled.find((action) => action.id === id)).filter(Boolean) : enabled.filter((action) => (action.category || "Frontend") === activeCategory);
  actions.forEach((action) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = action.label;
    btn.dataset.tooltip = window.answersHelp.BUTTON_HELP[action.id];
    btn.disabled = busy;
    btn.addEventListener("click", () => startWorkflow(action));
    panel.appendChild(btn);
  });
  els.promptBar.append(tabs, panel);
}

function startWorkflow(action) {
  if (!action.inputLabel) {
    sendPrompt(action.label, { id: action.id });
    return;
  }
  activeWorkflow = action;
  els.workflowTitle.textContent = action.label;
  els.workflowLabel.textContent = action.inputLabel;
  const isFrontendPicker = action.id === "website-health";
  const definitionOptions = action.definitionType ? (settings.definitions?.[action.definitionType] || []).map((item) => item.name) : null;
  const options = definitionOptions || action.options;
  const hasOptions = Array.isArray(options);
  const requiresConsent = Boolean(action.requiresConsent);
  const isSessionHealth = action.id === "session-health";
  const isHostPicker = action.id === "infra-health";
  $("hostPicker").classList.toggle("hidden", !isHostPicker);
  selectedHosts = new Map();
  hostNames = [];
  hostLoadId++;
  els.frontendPicker.classList.toggle("hidden", !isFrontendPicker);
  els.sessionConsentRow.classList.toggle("hidden", !requiresConsent);
  els.sessionIdRow.classList.toggle("hidden", !isSessionHealth);
  els.sessionIdInput.value = "";
  els.sessionConsent.checked = false;
  els.workflowSelect.classList.toggle("hidden", !hasOptions);
  els.workflowInput.classList.toggle("hidden", hasOptions);
  els.workflowInput.required = !hasOptions && !isSessionHealth && !isHostPicker && !action.optionalInput;
  els.workflowInput.disabled = false;
  els.workflowSelect.required = hasOptions;
  els.sessionIdInput.required = false;
  els.workflowSelect.innerHTML = "";
  if (hasOptions) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = action.definitionType ? `Select ${action.definitionType === "applications" ? "an application" : "a transaction"}...` : "Select a symptom...";
    placeholder.disabled = true;
    placeholder.selected = true;
    els.workflowSelect.appendChild(placeholder);
    options.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      els.workflowSelect.appendChild(option);
    });
  }
  const notice = $("workflowNotice");
  notice.textContent = action.definitionType && !options.length ? `No ${action.definitionType} configured. Add definitions in Settings.` : "";
  notice.classList.toggle("hidden", !notice.textContent);
  els.workflowInput.placeholder = isFrontendPicker ? "Search frontends..." : action.placeholder || "";
  els.workflowInput.setAttribute("aria-label", action.inputLabel);
  if (isFrontendPicker) {
    els.workflowInput.setAttribute("role", "combobox");
    els.workflowInput.setAttribute("aria-autocomplete", "list");
    els.workflowInput.setAttribute("aria-controls", "frontendOptions");
    els.workflowInput.setAttribute("aria-expanded", "false");
  } else {
    els.workflowInput.removeAttribute("role");
    els.workflowInput.removeAttribute("aria-autocomplete");
    els.workflowInput.removeAttribute("aria-controls");
    els.workflowInput.removeAttribute("aria-expanded");
    els.workflowInput.removeAttribute("aria-activedescendant");
  }
  els.workflowInput.value = "";
  els.workflowSelect.value = "";
  selectedFrontend = null;
  filteredFrontends = [];
  activeFrontendIndex = -1;
  els.workflowRunBtn.disabled = isFrontendPicker || hasOptions || requiresConsent;
  els.workflowOverlay.classList.remove("hidden");
  if (hasOptions) els.workflowSelect.focus();
  else els.workflowInput.focus();
  if (isFrontendPicker) loadFrontendOptions(action);
  if (isHostPicker) loadHostOptions();
}

async function loadHostOptions() {
  const requestId = hostLoadId;
  $("hostStatus").textContent = "Loading hosts...";
  $("hostOptions").replaceChildren();
  $("hostSelection").textContent = "All hosts";
  $("allHosts").checked = true;
  els.workflowInput.disabled = false;
  try {
    const hosts = await api.getHosts();
    if (requestId !== hostLoadId || activeWorkflow?.id !== "infra-health") return;
    hostNames = hosts;
    renderHostOptions();
  } catch (error) {
    if (requestId !== hostLoadId || activeWorkflow?.id !== "infra-health") return;
    $("hostStatus").textContent = `Could not load host list: ${cleanError(error)}. All-host analysis is still available.`;
  }
}

function renderHostOptions() {
  const search = els.workflowInput.value.trim().toLocaleLowerCase();
  const matches = hostNames.filter((host) => `${host.name} ${host.id}`.toLocaleLowerCase().includes(search));
  $("hostOptions").replaceChildren();
  matches.slice(0, 150).forEach((host) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    label.className = "toggle host-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.hostId = host.id;
    checkbox.checked = selectedHosts.has(host.id);
    checkbox.disabled = !checkbox.checked && selectedHosts.size >= 100;
    const name = document.createElement("span");
    name.textContent = host.name;
    name.title = host.id;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedHosts.set(host.id, host);
      else selectedHosts.delete(host.id);
      renderHostOptions();
      [...$("hostOptions").querySelectorAll("input")].find((input) => input.dataset.hostId === host.id)?.focus();
    });
    label.append(checkbox, name);
    item.appendChild(label);
    $("hostOptions").appendChild(item);
  });
  $("allHosts").checked = selectedHosts.size === 0;
  $("hostSelection").textContent = selectedHosts.size ? `${selectedHosts.size} selected: ${[...selectedHosts.values()].map((host) => host.name).join(", ")}` : "All hosts";
  $("hostStatus").textContent = `${matches.length} matching hosts${matches.length > 150 ? "; showing first 150 - refine search" : ""}.${hostNames.length >= 10000 ? " Host list capped at 10,000; All hosts queries the fleet independently." : ""}${selectedHosts.size >= 100 ? " Selection limit: 100 hosts." : ""}`;
}

async function loadFrontendOptions(action) {
  els.frontendStatus.textContent = "Loading frontends...";
  els.workflowInput.disabled = true;
  try {
    const names = await api.getFrontends();
    if (activeWorkflow !== action) return;
    frontendNames = Array.isArray(names) ? names : [];
    renderFrontendOptions();
  } catch (err) {
    if (activeWorkflow !== action) return;
    frontendNames = [];
    els.frontendOptions.innerHTML = "";
    els.frontendStatus.textContent = `Could not load frontends: ${cleanError(err)}`;
  } finally {
    if (activeWorkflow === action) els.workflowInput.disabled = false;
  }
}

function renderFrontendOptions() {
  const search = els.workflowInput.value.trim().toLocaleLowerCase();
  const matches = frontendNames.filter((name) => name.toLocaleLowerCase().includes(search));
  filteredFrontends = matches.slice(0, 100);
  activeFrontendIndex = filteredFrontends.length ? Math.min(activeFrontendIndex, filteredFrontends.length - 1) : -1;
  els.frontendOptions.innerHTML = "";

  filteredFrontends.forEach((name, index) => {
    const option = document.createElement("li");
    option.id = `frontend-option-${index}`;
    option.className = `frontend-option${index === activeFrontendIndex ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(name === selectedFrontend));
    option.textContent = name;
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectFrontend(name));
    els.frontendOptions.appendChild(option);
  });

  els.frontendOptions.classList.toggle("hidden", Boolean(selectedFrontend));
  els.frontendStatus.textContent = selectedFrontend
    ? `Selected: ${selectedFrontend}`
    : !matches.length
    ? frontendNames.length ? "No matching frontends." : "No frontends found."
    : matches.length > filteredFrontends.length
    ? `Showing the first ${filteredFrontends.length} of ${matches.length}. Refine your search.`
    : `${matches.length} frontend${matches.length === 1 ? "" : "s"}`;
  els.workflowInput.setAttribute("aria-expanded", String(!selectedFrontend && filteredFrontends.length > 0));
  if (activeFrontendIndex >= 0 && !selectedFrontend) {
    els.workflowInput.setAttribute("aria-activedescendant", `frontend-option-${activeFrontendIndex}`);
  } else {
    els.workflowInput.removeAttribute("aria-activedescendant");
  }
}

function selectFrontend(name) {
  selectedFrontend = name;
  els.workflowInput.value = name;
  els.workflowRunBtn.disabled = false;
  activeFrontendIndex = filteredFrontends.indexOf(name);
  renderFrontendOptions();
  els.workflowInput.focus();
}

function closeWorkflow() {
  els.workflowOverlay.classList.add("hidden");
  activeWorkflow = null;
  selectedFrontend = null;
}

function newChat() {
  conversationState = null;
  els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
  els.emptyState.classList.remove("hidden");
  updateExportButton();
  els.input.focus();
}

async function exportChatPdf() {
  const messages = [...els.messages.querySelectorAll(".msg")].map((element) => ({
    role: element.classList.contains("msg-user") ? "user" :
      element.classList.contains("msg-ai") ? "assistant" :
      element.classList.contains("msg-error") ? "error" : null,
    text: element.textContent.trim(),
    html: element.innerHTML,
    timestamp: element.dataset.timestamp,
  })).filter((message) => message.role && message.text);
  if (!messages.length || busy) return;

  const originalLabel = els.exportPdfBtn.textContent;
  els.exportPdfBtn.disabled = true;
  try {
    const result = await api.exportPdf({ messages });
    if (!result.canceled) {
      els.exportPdfBtn.textContent = "PDF saved";
      setTimeout(() => { els.exportPdfBtn.textContent = originalLabel; }, 1800);
    }
  } catch (err) {
    addMessage("error", `PDF export failed: ${cleanError(err)}`);
  } finally {
    updateExportButton();
  }
}

// Settings dialog

function openSettings() {
  els.tenantUrl.value = settings.tenantUrl;
  els.token.value = "";
  els.tokenHint.textContent = settings.hasToken
    ? "A token is saved (encrypted). Leave blank to keep it, or paste a new one to replace it."
    : "Paste a Dynatrace platform token (dt0s16...).";
  els.testResult.textContent = "";
  els.testResult.className = "muted";
  els.saveError.textContent = "";
  els.dataMode.checked = settings.dataMode !== false;
  const buttonSettings = $("buttonSettings");
  buttonSettings.replaceChildren();
  FRONTEND_ACTIONS.forEach((action) => {
    const label = document.createElement("label");
    label.className = "toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.action = action.id;
    checkbox.checked = settings.buttons?.[action.id] !== false;
    const text = document.createElement("span");
    text.textContent = action.label;
    label.append(checkbox, text);
    buttonSettings.appendChild(label);
  });
  for (const type of ["applications", "transactions"]) {
    $(type === "applications" ? "applicationDefinitions" : "transactionDefinitions").replaceChildren();
    (settings.definitions?.[type] || []).forEach((definition) => addDefinitionRow(type, definition));
  }
  els.overlay.classList.remove("hidden");
  els.tenantUrl.focus();
}

function addDefinitionRow(type, definition = {}) {
  const container = $(type === "applications" ? "applicationDefinitions" : "transactionDefinitions");
  if (container.children.length >= 50) return;
  const row = document.createElement("div");
  row.className = "definition-row";
  const fields = type === "applications" ? [["name", "Application name"], ["frontend", "Exact frontend name"], ["service", "Exact entry service name"]]
    : [["name", "Transaction name"], ["service", "Exact service name"], ["endpoint", "Exact endpoint name"]];
  fields.forEach(([field, title]) => {
    const label = document.createElement("label");
    label.className = "field";
    const text = document.createElement("span");
    text.textContent = title;
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.field = field;
    input.maxLength = field === "name" ? 200 : 500;
    input.value = definition[field] || "";
    label.append(text, input);
    row.appendChild(label);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-ghost definition-remove";
  remove.textContent = "-";
  remove.title = "Remove definition";
  remove.setAttribute("aria-label", "Remove definition");
  remove.addEventListener("click", () => row.remove());
  row.appendChild(remove);
  container.appendChild(row);
}

function collectDefinitions() {
  return Object.fromEntries([["applications", "applicationDefinitions"], ["transactions", "transactionDefinitions"]].map(([type, id]) => [type,
    [...$(id).querySelectorAll(".definition-row")].map((row) => Object.fromEntries([...row.querySelectorAll("input")].map((input) => [input.dataset.field, input.value.trim()])))
      .filter((definition) => Object.values(definition).some(Boolean)),
  ]));
}

function hideButtonTooltip() {
  $("buttonTooltip").classList.add("hidden");
  if (tooltipButton) {
    if (tooltipOriginalTitle !== null) tooltipButton.setAttribute("title", tooltipOriginalTitle);
    if (tooltipOriginalDescription === null) tooltipButton.removeAttribute("aria-describedby");
    else tooltipButton.setAttribute("aria-describedby", tooltipOriginalDescription);
  }
  tooltipButton = null;
  tooltipOriginalTitle = null;
  tooltipOriginalDescription = null;
}

function showButtonTooltip(button) {
  if (button === tooltipButton) return;
  hideButtonTooltip();
  const description = button?.dataset.tooltip || button?.getAttribute("title");
  if (!description) return;
  const tooltip = $("buttonTooltip");
  tooltipButton = button;
  tooltipOriginalTitle = button.getAttribute("title");
  tooltipOriginalDescription = button.getAttribute("aria-describedby");
  button.removeAttribute("title");
  button.setAttribute("aria-describedby", [tooltipOriginalDescription, "buttonTooltip"].filter(Boolean).join(" "));
  tooltip.textContent = description;
  tooltip.classList.remove("hidden");
  const bounds = button.getBoundingClientRect();
  const size = tooltip.getBoundingClientRect();
  const left = Math.max(12, Math.min(bounds.left + bounds.width / 2 - size.width / 2, window.innerWidth - size.width - 12));
  const below = bounds.bottom + 8;
  const top = below + size.height <= window.innerHeight - 12 ? below : Math.max(12, bounds.top - size.height - 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function installButtonTooltips() {
  Object.entries(window.answersHelp.CONTROL_HELP).forEach(([id, description]) => {
    if ($(id)) $(id).dataset.tooltip = description;
  });
  document.addEventListener("pointerover", (event) => {
    const button = event.target.closest("button");
    if (button) showButtonTooltip(button);
  });
  document.addEventListener("pointerout", (event) => {
    if (tooltipButton && !tooltipButton.contains(event.relatedTarget)) hideButtonTooltip();
  });
  document.addEventListener("focusin", (event) => {
    const button = event.target.closest("button");
    if (button) showButtonTooltip(button);
  });
  document.addEventListener("focusout", hideButtonTooltip);
  document.addEventListener("click", hideButtonTooltip, true);
  document.addEventListener("scroll", hideButtonTooltip, true);
  window.addEventListener("resize", hideButtonTooltip);
}

async function openHelp() {
  hideButtonTooltip();
  helpReturnFocus = document.activeElement;
  els.helpOverlay.classList.remove("hidden");
  els.closeHelpBtn.focus();
  if (guideLoaded || guideLoading) return;
  guideLoading = true;
  els.helpContent.textContent = "Loading user guide...";
  try {
    const markdown = await api.getUserGuide();
    els.helpContent.innerHTML = window.renderMarkdown(markdown);
    const topics = [...els.helpContent.querySelectorAll("h2")];
    els.helpTopics.replaceChildren();
    topics.forEach((heading, index) => {
      heading.id = `guide-topic-${index}`;
      heading.tabIndex = -1;
      const option = document.createElement("option");
      option.value = heading.id;
      option.textContent = heading.textContent;
      els.helpTopics.appendChild(option);
    });
    els.helpTopics.disabled = !topics.length;
    guideLoaded = true;
  } catch (error) {
    els.helpContent.textContent = `The user guide could not be loaded: ${cleanError(error)}. Close and reopen Help to retry.`;
    els.helpTopics.replaceChildren(new Option("Guide unavailable", ""));
    els.helpTopics.disabled = true;
  } finally {
    guideLoading = false;
  }
}

function closeHelp() {
  hideButtonTooltip();
  els.helpOverlay.classList.add("hidden");
  if (helpReturnFocus?.isConnected) helpReturnFocus.focus();
  else els.helpBtn.focus();
}

async function downloadUserGuide() {
  els.downloadUserGuideBtn.disabled = true;
  els.guideDownloadStatus.className = "muted";
  els.guideDownloadStatus.textContent = "Preparing offline user guide...";
  try {
    const result = await api.downloadUserGuide();
    els.guideDownloadStatus.className = result.canceled ? "muted" : "ok-text";
    els.guideDownloadStatus.textContent = result.canceled ? "Download canceled." : `User guide saved: ${result.filePath}`;
  } catch (error) {
    els.guideDownloadStatus.className = "error-text";
    els.guideDownloadStatus.textContent = `User guide download failed: ${cleanError(error)}`;
  } finally {
    els.downloadUserGuideBtn.disabled = false;
  }
}

function closeSettings() {
  els.overlay.classList.add("hidden");
}

async function testConnection() {
  els.testBtn.disabled = true;
  els.testResult.className = "muted";
  els.testResult.textContent = "Testing...";
  try {
    const r = await api.testConnection({ tenantUrl: els.tenantUrl.value, token: els.token.value });
    if (r.chatAvailable) {
      els.testResult.className = "ok-text";
      els.testResult.textContent = r.nl2dqlAvailable
        ? "Connected. Data access for each check depends on the token's permissions."
        : "Connected. Health checks use dedicated queries; free-text data questions need DQL generation.";
    } else {
      els.testResult.className = "error-text";
      els.testResult.textContent = `Connected, but chat is not available for this token. Skills: ${r.skills.join(", ") || "none"}. Check the davis-copilot:conversations:execute scope.`;
    }
  } catch (err) {
    els.testResult.className = "error-text";
    els.testResult.textContent = cleanError(err);
  } finally {
    els.testBtn.disabled = false;
  }
}

async function saveSettings() {
  els.saveError.textContent = "";
  if (!els.token.value.trim() && !settings.hasToken) {
    els.saveError.textContent = "A token is required.";
    return;
  }
  try {
    const tenantChanged = settings.tenantUrl !== els.tenantUrl.value.trim();
    settings = {
      ...settings,
      ...(await api.saveSettings({
        tenantUrl: els.tenantUrl.value,
        token: els.token.value,
        dataMode: els.dataMode.checked,
        buttons: Object.fromEntries([...$("buttonSettings").querySelectorAll("input")].map((input) => [input.dataset.action, input.checked])),
        definitions: window.healthChecks.normalizeDefinitions(collectDefinitions()),
      })),
    };
    if (tenantChanged) newChat();
    renderPromptBar();
    setStatus("unknown", isConfigured() ? "Configured" : "Not configured");
    closeSettings();
  } catch (err) {
    els.saveError.textContent = cleanError(err);
  }
}

// Wiring

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = "";
  sendPrompt(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight}px`;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideButtonTooltip();
  if (!els.helpOverlay.classList.contains("hidden")) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeHelp();
    } else if (e.key === "Tab") {
      const focusable = [...els.helpOverlay.querySelectorAll("button:not(:disabled), select:not(:disabled), [tabindex='0']")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (e.key === "Escape" && !els.overlay.classList.contains("hidden")) closeSettings();
  if (e.key === "Escape" && !els.workflowOverlay.classList.contains("hidden")) closeWorkflow();
});

els.newChatBtn.addEventListener("click", newChat);
els.exportPdfBtn.addEventListener("click", exportChatPdf);
els.settingsBtn.addEventListener("click", openSettings);
els.helpBtn.addEventListener("click", openHelp);
els.closeHelpBtn.addEventListener("click", closeHelp);
els.downloadUserGuideBtn.addEventListener("click", downloadUserGuide);
els.helpTopics.addEventListener("change", () => {
  const heading = $(els.helpTopics.value);
  if (heading) {
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }
});
els.closeBtn.addEventListener("click", closeSettings);
$("cancelWorkflowBtn").addEventListener("click", closeWorkflow);
els.workflowForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const action = activeWorkflow;
  if (action?.id === "infra-health") {
    const hosts = [...selectedHosts.values()];
    closeWorkflow();
    sendPrompt(action.label, { id: action.id, value: hosts }, `${action.label}: ${hosts.length ? hosts.map((host) => host.name).join(", ") : "All hosts"}`);
    return;
  }
  let value;
  if (action?.id === "website-health") {
    value = selectedFrontend && selectedFrontend === els.workflowInput.value ? selectedFrontend : "";
  } else if (action?.id === "session-health") {
    value = {
      userIdentifier: els.workflowInput.value.trim(),
      sessionId: els.sessionIdInput.value.trim(),
    };
    if (!value.userIdentifier && !value.sessionId) return;
  } else {
    value = action?.options || action?.definitionType ? els.workflowSelect.value : els.workflowInput.value.trim();
  }
  if (!action || (!value && !action.optionalInput) || (typeof value === "object" && !value.userIdentifier && !value.sessionId)) return;
  closeWorkflow();
  sendPrompt(action.label, {
    id: action.id,
    value,
    ...(action.requiresConsent ? { consent: els.sessionConsent.checked } : {}),
  }, action.id === "session-health"
    ? `${action.label}: ${value.userIdentifier || "no user identifier"}; ${value.sessionId}`
    : `${action.label}: ${value || "Monitored environment"}`);
});
els.workflowInput.addEventListener("input", () => {
  if (activeWorkflow?.id === "infra-health") {
    renderHostOptions();
    return;
  }
  if (activeWorkflow?.id !== "website-health") return;
  if (els.workflowInput.value !== selectedFrontend) {
    selectedFrontend = null;
    els.workflowRunBtn.disabled = true;
  }
  activeFrontendIndex = -1;
  renderFrontendOptions();
});
els.workflowInput.addEventListener("keydown", (event) => {
  if (activeWorkflow?.id !== "website-health" || !filteredFrontends.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    activeFrontendIndex = (activeFrontendIndex + step + filteredFrontends.length) % filteredFrontends.length;
    renderFrontendOptions();
  } else if (event.key === "Enter" && !selectedFrontend) {
    event.preventDefault();
    selectFrontend(filteredFrontends[activeFrontendIndex >= 0 ? activeFrontendIndex : 0]);
  }
});
els.workflowSelect.addEventListener("change", () => {
  els.workflowRunBtn.disabled = !els.workflowSelect.value;
});
els.workflowInput.addEventListener("input", () => {
  if (activeWorkflow?.requiresConsent) {
    els.workflowRunBtn.disabled = !(els.workflowInput.value.trim() || els.sessionIdInput.value.trim()) || !els.sessionConsent.checked;
  }
});
els.sessionIdInput.addEventListener("input", () => {
  if (activeWorkflow?.requiresConsent) {
    els.workflowRunBtn.disabled = !(els.workflowInput.value.trim() || els.sessionIdInput.value.trim()) || !els.sessionConsent.checked;
  }
});
els.sessionConsent.addEventListener("change", () => {
  if (activeWorkflow?.requiresConsent) {
    els.workflowRunBtn.disabled = !(els.workflowInput.value.trim() || els.sessionIdInput.value.trim()) || !els.sessionConsent.checked;
  }
});
els.cancelBtn.addEventListener("click", closeSettings);
$("allHosts").addEventListener("change", () => {
  selectedHosts.clear();
  renderHostOptions();
});
els.saveBtn.addEventListener("click", saveSettings);
els.testBtn.addEventListener("click", testConnection);
$("addApplicationBtn").addEventListener("click", () => addDefinitionRow("applications"));
$("addTransactionBtn").addEventListener("click", () => addDefinitionRow("transactions"));

(async function init() {
  installButtonTooltips();
  settings = await api.getSettings();
  els.appVersion.textContent = settings.version ? `v${settings.version}` : "";
  renderPromptBar();
  if (isConfigured()) {
    setStatus("unknown", "Configured");
    els.input.focus();
  } else {
    openSettings();
  }
})();

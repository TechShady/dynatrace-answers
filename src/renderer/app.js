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

const FRONTEND_ACTIONS = [
  { id: "infra-health", label: "Infra Health", inputLabel: "Hosts", placeholder: "Search hosts..." },
  { id: "website-health", label: "Website health", inputLabel: "Frontend application", placeholder: "Application name" },
  { id: "system-health", label: "System health" },
  { id: "guided-triage", label: "Guided triage", inputLabel: "Reported symptom", placeholder: "What did the caller report?" },
  { id: "session-health", label: "Session health", inputLabel: "User identifier or tag (optional)", placeholder: "e.g. maria", requiresConsent: true },
  {
    id: "impact-scope",
    label: "Impact scope",
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
];

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

function renderAnswer(div, result) {
  div.innerHTML = "";
  if (result.sessionReport || result.infraReport) {
    if (result.infraReport) renderInfraReport(div, result.infraReport);
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
  FRONTEND_ACTIONS.filter((action) => settings.buttons?.[action.id] !== false).forEach((action) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = action.label;
    btn.disabled = busy;
    btn.addEventListener("click", () => startWorkflow(action));
    els.promptBar.appendChild(btn);
  });
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
  const hasOptions = Array.isArray(action.options);
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
  els.workflowInput.required = !hasOptions && !isSessionHealth && !isHostPicker;
  els.workflowSelect.required = hasOptions;
  els.sessionIdInput.required = false;
  els.workflowSelect.innerHTML = "";
  if (hasOptions) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a symptom...";
    placeholder.disabled = true;
    placeholder.selected = true;
    els.workflowSelect.appendChild(placeholder);
    action.options.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      els.workflowSelect.appendChild(option);
    });
  }
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
  els.overlay.classList.remove("hidden");
  els.tenantUrl.focus();
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
        ? "Connected. Frontend checks can query errors and page performance."
        : "Connected. Frontend health checks can query metrics; free-text data questions need DQL generation.";
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
  if (e.key === "Escape" && !els.overlay.classList.contains("hidden")) closeSettings();
  if (e.key === "Escape" && !els.workflowOverlay.classList.contains("hidden")) closeWorkflow();
});

els.newChatBtn.addEventListener("click", newChat);
els.exportPdfBtn.addEventListener("click", exportChatPdf);
els.settingsBtn.addEventListener("click", openSettings);
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
    value = action?.options ? els.workflowSelect.value : els.workflowInput.value.trim();
  }
  if (!action || !value || (typeof value === "object" && !value.userIdentifier && !value.sessionId)) return;
  closeWorkflow();
  sendPrompt(action.label, {
    id: action.id,
    value,
    ...(action.requiresConsent ? { consent: els.sessionConsent.checked } : {}),
  }, action.id === "session-health"
    ? `${action.label}: ${value.userIdentifier || "no user identifier"}; ${value.sessionId}`
    : `${action.label}: ${value}`);
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

(async function init() {
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

"use strict";

const api = window.oncall;
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

const FRONTEND_ACTIONS = [
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
  return String(text || "")
    .replace(/If you want help with creating DQL queries,\s*ask your admin to enable Agentic AI\.?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderAnswer(div, result) {
  div.innerHTML = window.renderMarkdown(sanitizeAnswer(result.text) || "_No answer returned._");

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
  FRONTEND_ACTIONS.forEach((action) => {
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
  els.frontendPicker.classList.toggle("hidden", !isFrontendPicker);
  els.sessionConsentRow.classList.toggle("hidden", !requiresConsent);
  els.sessionIdRow.classList.toggle("hidden", !isSessionHealth);
  els.sessionIdInput.value = "";
  els.sessionConsent.checked = false;
  els.workflowSelect.classList.toggle("hidden", !hasOptions);
  els.workflowInput.classList.toggle("hidden", hasOptions);
  els.workflowInput.required = !hasOptions && !isSessionHealth;
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
    text: element.innerText.trim(),
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
els.saveBtn.addEventListener("click", saveSettings);
els.testBtn.addEventListener("click", testConnection);

(async function init() {
  settings = await api.getSettings();
  renderPromptBar();
  if (isConfigured()) {
    setStatus("unknown", "Configured");
    els.input.focus();
  } else {
    openSettings();
  }
})();

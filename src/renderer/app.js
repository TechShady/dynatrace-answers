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
  settingsBtn: $("settingsBtn"),
  status: $("connectionStatus"),
  workflowOverlay: $("workflowOverlay"),
  workflowForm: $("workflowForm"),
  workflowTitle: $("workflowTitle"),
  workflowLabel: $("workflowLabel"),
  workflowInput: $("workflowInput"),
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

const FRONTEND_ACTIONS = [
  { id: "website-health", label: "Website health", inputLabel: "Frontend application", placeholder: "Application name" },
  { id: "system-health", label: "System health" },
  { id: "session-health", label: "Session health", inputLabel: "User tag", placeholder: "User tag or identifier" },
  { id: "impact-scope", label: "Impact scope", inputLabel: "Reported symptom", placeholder: "What did the user experience?" },
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
  els.promptBar.querySelectorAll("button").forEach((b) => (b.disabled = value));
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessage(kind, content) {
  els.emptyState.classList.add("hidden");
  const div = document.createElement("div");
  div.className = `msg msg-${kind}`;
  if (content !== undefined) div.textContent = content;
  els.messages.appendChild(div);
  scrollToBottom();
  return div;
}

function renderAnswer(div, result) {
  div.innerHTML = window.renderMarkdown(result.text || "_No answer returned._");

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
    activeRequest.div.innerHTML = window.renderMarkdown(activeRequest.text);
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
  els.workflowInput.placeholder = action.placeholder;
  els.workflowInput.value = "";
  els.workflowOverlay.classList.remove("hidden");
  els.workflowInput.focus();
}

function closeWorkflow() {
  els.workflowOverlay.classList.add("hidden");
  activeWorkflow = null;
}

function newChat() {
  conversationState = null;
  els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
  els.emptyState.classList.remove("hidden");
  els.input.focus();
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
els.settingsBtn.addEventListener("click", openSettings);
els.closeBtn.addEventListener("click", closeSettings);
$("cancelWorkflowBtn").addEventListener("click", closeWorkflow);
els.workflowForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const action = activeWorkflow;
  const value = els.workflowInput.value.trim();
  if (!action || !value) return;
  closeWorkflow();
  sendPrompt(action.label, { id: action.id, value }, `${action.label}: ${value}`);
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

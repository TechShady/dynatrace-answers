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
  overlay: $("settingsOverlay"),
  tenantUrl: $("tenantUrl"),
  token: $("token"),
  tokenHint: $("tokenHint"),
  dataMode: $("dataMode"),
  testBtn: $("testBtn"),
  testResult: $("testResult"),
  promptList: $("promptList"),
  addPromptBtn: $("addPromptBtn"),
  resetPromptsBtn: $("resetPromptsBtn"),
  saveBtn: $("saveSettingsBtn"),
  cancelBtn: $("cancelSettingsBtn"),
  closeBtn: $("closeSettingsBtn"),
  saveError: $("saveError"),
};

let settings = { tenantUrl: "", hasToken: false, prompts: [], defaultPrompts: [] };
let conversationState = null;
let busy = false;
let activeRequest = null;

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

function decorateCodeBlocks(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pre.querySelector("code")?.textContent || "");
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
    pre.appendChild(btn);
  });
}

function renderAnswer(div, result) {
  div.innerHTML = window.renderMarkdown(result.text || "_No answer returned._");
  decorateCodeBlocks(div);
  if (result.dql || result.queryError) div.prepend(buildDataPanel(result));

  if (result.notifications?.length) {
    const box = document.createElement("div");
    box.className = "notifications";
    result.notifications.forEach((n) => {
      const p = document.createElement("div");
      p.textContent = `${n.severity || "Notice"}: ${n.message || ""}`;
      box.appendChild(p);
    });
    div.appendChild(box);
  }

  const sources = (result.sources || []).filter((s) => s && s.url);
  if (sources.length) {
    const box = document.createElement("div");
    box.className = "sources";
    box.textContent = "Sources";
    const ul = document.createElement("ul");
    sources.forEach((s) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = s.url;
      a.dataset.external = "1";
      a.textContent = s.title || s.url;
      li.appendChild(a);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    div.appendChild(box);
  }
}

function buildDataPanel(result) {
  const details = document.createElement("details");
  details.className = "data-panel";
  const summary = document.createElement("summary");
  summary.textContent = result.queryError
    ? `Environment query failed: ${result.queryError}`
    : `Queried your environment: ${result.recordCount ?? 0} record(s)`;
  if (result.queryError) {
    summary.classList.add("error-text");
    details.open = true;
  }
  details.appendChild(summary);
  if (result.dql) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = result.dql;
    pre.appendChild(code);
    details.appendChild(pre);
    decorateCodeBlocks(details);
  }
  return details;
}

async function sendPrompt(text) {
  const prompt = String(text || "").trim();
  if (!prompt || busy) return;
  if (!isConfigured()) {
    openSettings();
    return;
  }

  addMessage("user", prompt);
  const aiDiv = addMessage("ai");
  aiDiv.innerHTML = '<span class="progress">Thinking...</span>';
  setBusy(true);

  const requestId = crypto.randomUUID();
  activeRequest = { id: requestId, div: aiDiv, text: "" };

  try {
    const result = await api.send({ requestId, text: prompt, state: conversationState });
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
  settings.prompts.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = p.label;
    btn.title = p.prompt;
    btn.disabled = busy;
    btn.addEventListener("click", () => sendPrompt(p.prompt));
    els.promptBar.appendChild(btn);
  });
}

function newChat() {
  conversationState = null;
  els.messages.querySelectorAll(".msg").forEach((m) => m.remove());
  els.emptyState.classList.remove("hidden");
  els.input.focus();
}

// Settings dialog

function addPromptRow(p = { label: "", prompt: "" }) {
  const row = document.createElement("div");
  row.className = "prompt-item";

  const label = document.createElement("input");
  label.type = "text";
  label.placeholder = "Button label";
  label.maxLength = 60;
  label.value = p.label;
  label.className = "prompt-label";

  const prompt = document.createElement("textarea");
  prompt.rows = 2;
  prompt.placeholder = "Prompt text sent to Dynatrace Intelligence";
  prompt.value = p.prompt;
  prompt.className = "prompt-text";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-ghost";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => row.remove());

  row.append(label, prompt, remove);
  els.promptList.appendChild(row);
}

function renderPromptEditor(prompts) {
  els.promptList.innerHTML = "";
  prompts.forEach((p) => addPromptRow(p));
}

function readPromptEditor() {
  return [...els.promptList.querySelectorAll(".prompt-item")]
    .map((row) => ({
      label: row.querySelector(".prompt-label").value.trim(),
      prompt: row.querySelector(".prompt-text").value.trim(),
    }))
    .filter((p) => p.label && p.prompt);
}

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
  renderPromptEditor(settings.prompts);
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
    if (r.chatAvailable && (r.nl2dqlAvailable || !els.dataMode.checked)) {
      els.testResult.className = "ok-text";
      els.testResult.textContent = "Connected. Dynatrace Intelligence chat is available.";
    } else if (r.chatAvailable) {
      els.testResult.className = "error-text";
      els.testResult.textContent =
        "Chat works, but DQL generation is not available. Add davis-copilot:nl2dql:execute or turn off data mode.";
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
  const prompts = readPromptEditor();
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
        prompts,
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

document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-external]");
  if (!link) return;
  e.preventDefault();
  api.openExternal(link.href);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.overlay.classList.contains("hidden")) closeSettings();
});

els.newChatBtn.addEventListener("click", newChat);
els.settingsBtn.addEventListener("click", openSettings);
els.closeBtn.addEventListener("click", closeSettings);
els.cancelBtn.addEventListener("click", closeSettings);
els.saveBtn.addEventListener("click", saveSettings);
els.testBtn.addEventListener("click", testConnection);
els.addPromptBtn.addEventListener("click", () => addPromptRow());
els.resetPromptsBtn.addEventListener("click", () => renderPromptEditor(settings.defaultPrompts));

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

"use strict";

const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const SKILLS_PATH = "/platform/davis/copilot/v1/skills";
const REQUEST_TIMEOUT_MS = 180000;

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
    };
  } catch {
    return { tenantUrl: "", tokenEnc: "", prompts: DEFAULT_PROMPTS };
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
      detail = json?.error?.message || json?.message || body;
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
    return `Access denied (403). The token needs the davis-copilot:conversations:execute scope and Dynatrace Intelligence must be enabled for the tenant. ${detail}`;
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

function registerIpc() {
  ipcMain.handle("settings:get", () => publicSettings(loadSettings()));

  ipcMain.handle("settings:save", (_event, input) => {
    const current = loadSettings();
    const token = String(input?.token || "").trim();
    const next = {
      tenantUrl: normalizeTenantUrl(input?.tenantUrl),
      tokenEnc: token ? encryptToken(token) : current.tokenEnc,
      prompts: sanitizePrompts(Array.isArray(input?.prompts) ? input.prompts : []),
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
    return { skills, chatAvailable: skills.includes("conversation") };
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

    return callDynatrace(
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

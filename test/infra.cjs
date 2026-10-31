"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const infra = require("../src/infra");
const healthChecks = require("../src/checks");
const help = require("../src/help");
const { verifyHelpUi } = require("./help.cjs");
const root = path.resolve(__dirname, "..");
const hosts = Array.from({ length: 12 }, (_, index) => ({ id: `HOST-${(index + 1).toString(16).toUpperCase()}`, name: `host-${String(index + 1).padStart(2, "0")}` }));

async function fixtureQuery(_creds, query) {
  const selectedIds = query.match(/HOST-[A-F0-9]+/g);
  const selected = selectedIds ? hosts.filter((host) => selectedIds.includes(host.id)) : hosts;
  return selected.map((host) => {
    const index = hosts.indexOf(host);
    const average = query.includes("dt.host.cpu") ? 50 + index * 4 : 95 - index * 4;
    return query.includes("usage = avg")
      ? { ...host, usage: ["50", "85", "95", null], timeframe: { start: "2026-10-29T10:00:00Z" }, interval: "300000000000" }
      : { ...host, average: String(average), peak: "98" };
  });
}

function exposeFixture() {
  let settings = { tenantUrl: "https://example.apps.dynatrace.com", hasToken: true, dataMode: true, version: "test", buttons: {} };
  let lastRequest = null;
  let guideDownloadMode = "success";
  const { contextBridge } = require("electron");
  contextBridge.exposeInMainWorld("answers", {
    getSettings: async () => settings,
    saveSettings: async (value) => (settings = { ...settings, ...value, hasToken: true }),
    getHosts: async () => hosts,
    getFrontends: async () => ["example frontend"],
    getUserGuide: async () => help.readUserGuide(),
    downloadUserGuide: async () => {
      if (guideDownloadMode === "error") throw new Error("Destination unavailable");
      return guideDownloadMode === "cancel" ? { canceled: true } : { canceled: false, filePath: "offline-user-guide.html" };
    },
    onChatEvent: () => {},
    send: async (request) => {
      lastRequest = request;
      const data = await infra.queryInfraHealth({}, { value: infra.resolveHosts(request.workflow.value) }, fixtureQuery, () => {});
      return { ...data, text: "Synthetic infrastructure analysis." };
    },
  });
  contextBridge.exposeInMainWorld("fixture", { getLastRequest: () => lastRequest, setGuideDownloadMode: (mode) => { guideDownloadMode = mode; } });
}

async function checkUi() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = (condition) => new Promise((resolve, reject) => {
    if (condition()) return resolve();
    const observer = new MutationObserver(() => {
      if (condition()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("UI condition timed out")); }, 10000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  const chip = () => [...document.querySelectorAll(".chip")].find((button) => button.textContent === "Infra Health");
  const search = (value) => {
    const input = document.getElementById("workflowInput");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await waitFor(() => chip());
  document.getElementById("settingsBtn").click();
  const switches = document.querySelectorAll("#buttonSettings input");
  check(switches.length === 20, "Every health button must have a switch");
  document.querySelector('[data-action="infra-health"]').checked = false;
  document.getElementById("saveSettingsBtn").click();
  await waitFor(() => !chip());
  check((await window.answers.getSettings()).buttons["infra-health"] === false, "Disabled setting must persist");
  document.getElementById("settingsBtn").click();
  check(!document.querySelector('[data-action="infra-health"]').checked, "Reopened settings must preserve switch");
  document.querySelector('[data-action="infra-health"]').checked = true;
  document.getElementById("saveSettingsBtn").click();
  await waitFor(() => chip());
  chip().click();
  await waitFor(() => document.querySelectorAll("#hostOptions input").length === 12);
  check(document.getElementById("allHosts").checked, "All hosts must be the default");
  check(!document.getElementById("workflowInput").required, "All-host analysis must not require search text");
  document.getElementById("workflowForm").requestSubmit();
  await waitFor(() => document.querySelectorAll(".infra-table tbody tr").length === 20 && !document.getElementById("sendBtn").disabled);
  check(window.fixture.getLastRequest().workflow.value.length === 0, "Default must request the full fleet");
  const first = document.querySelector(".host-link");
  check(first.textContent === "host-12", "CPU ranking must show highest average first");
  first.click();
  await waitFor(() => document.querySelectorAll(".msg-ai").length === 2 && document.querySelectorAll(".infra-table").length === 6 && !document.getElementById("sendBtn").disabled);
  check(window.fixture.getLastRequest().workflow.value[0].id === "HOST-C", "Host link must deep-dive exact host ID");
  check(document.querySelectorAll(".msg-ai")[1].textContent.includes("Five-Minute Readings"), "Deep dive must include readings");
  chip().click();
  await waitFor(() => document.querySelectorAll("#hostOptions input").length === 12);
  search("host-01");
  document.querySelector("#hostOptions input").click();
  search("host-02");
  document.querySelector("#hostOptions input").click();
  check(!document.getElementById("allHosts").checked, "Specific selections must replace All hosts");
  check(document.getElementById("hostSelection").textContent.includes("2 selected"), "Selection must survive searches");
  document.getElementById("workflowForm").requestSubmit();
  await waitFor(() => document.querySelectorAll(".msg-ai").length === 3 && !document.getElementById("sendBtn").disabled);
  check(window.fixture.getLastRequest().workflow.value.length === 2, "Must submit both selected hosts");
  check(document.querySelectorAll(".msg-ai")[2].textContent.includes("Selected Hosts"), "Multi-host report must compare every selected host");
  chip().click();
  await waitFor(() => document.querySelectorAll("#hostOptions input").length === 12);
  document.querySelector("#hostOptions input").click();
  document.getElementById("allHosts").click();
  check(document.getElementById("allHosts").checked && document.querySelectorAll("#hostOptions input:checked").length === 0, "All hosts must clear specific selections");
  document.getElementById("cancelWorkflowBtn").click();
  check(document.documentElement.scrollWidth <= window.innerWidth, "Page must not overflow horizontally");
  return "settings switches, default all, CPU/memory rankings, host drill-down, multi-selection, search retention, reset, layout";
}

async function runUiWorker() {
  const { app, BrowserWindow } = require("electron");
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { preload: __filename, sandbox: false, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(root, "src/renderer/index.html"));
    console.log(`PASS: Help UI - ${await window.webContents.executeJavaScript(`(${verifyHelpUi.toString()})()`)}`);
    console.log(`PASS: Electron UI - ${await window.webContents.executeJavaScript(`(${checkUi.toString()})()`)}`);
    window.setSize(520, 800);
    assert.equal(await window.webContents.executeJavaScript("document.documentElement.scrollWidth <= window.innerWidth"), true);
    console.log("PASS: compact-window layout");
  } finally { window.destroy(); app.quit(); }
}

async function verifyInfra() {
  for (const file of ["src/main.js", "src/preload.js", "src/renderer/app.js", "src/infra.js"]) new vm.Script(fs.readFileSync(path.join(root, file), "utf8"));
  const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  const settingsContext = vm.createContext({ FRONTEND_WORKFLOWS: { "website-health": {}, "system-health": {} }, healthChecks });
  vm.runInContext(source.slice(source.indexOf("function normalizeButtons("), source.indexOf("function writeSettings(")), settingsContext);
  assert.equal(settingsContext.normalizeButtons()["website-health"], true);
  assert.equal(settingsContext.normalizeButtons({ "website-health": false })["website-health"], false);
  assert.equal(settingsContext.normalizeButtons({})["infra-health"], true);
  let stored = JSON.stringify({ tenantUrl: "https://example.apps.dynatrace.com", tokenEnc: "encrypted", dataMode: false });
  const persistenceContext = vm.createContext({
    healthChecks,
    FRONTEND_WORKFLOWS: { "website-health": {}, "system-health": {} },
    app: { getPath: () => root, getVersion: () => "test" },
    path,
    fs: {
      existsSync: () => true,
      readFileSync: () => stored,
      mkdirSync: () => {},
      writeFileSync: (_file, value) => { stored = value; },
    },
  });
  vm.runInContext(source.slice(source.indexOf("function settingsFile("), source.indexOf("function normalizeTenantUrl(")), persistenceContext);
  const saved = persistenceContext.loadSettings();
  assert.equal(saved.buttons["infra-health"], true);
  saved.buttons["infra-health"] = false;
  persistenceContext.writeSettings(saved);
  assert.equal(persistenceContext.publicSettings(persistenceContext.loadSettings()).buttons["infra-health"], false);
  assert.equal(persistenceContext.loadSettings().tokenEnc, "encrypted");
  assert.equal(persistenceContext.loadSettings().dataMode, false);
  assert.throws(() => infra.resolveHosts([{ id: "HOST-A\" | malicious" }]));
  assert.throws(() => infra.resolveHosts(Array(101).fill(hosts[0])));
  assert.equal(infra.resolveHosts([hosts[0], hosts[0]]).length, 1);
  assert.equal(infra.percentage(null), null);
  assert.equal(infra.percentage("91.5"), 91.5);
  assert.equal(infra.percentage(101), null);
  assert.equal(infra.utilizationStatus(null, null), "Inconclusive");
  assert.equal(infra.utilizationStatus(90, 99), "Critical");
  assert.equal(infra.utilizationStatus(80, 85), "Warning");
  assert.equal(infra.utilizationStatus(50, 95), "Spike observed");
  assert.equal(infra.utilizationStatus(50, 60), "Below threshold");
  assert.match(infra.metricQuery("cpu", [hosts[0]]), /filter:\{in\(dt.entity.host, array\("HOST-1"\)\)\}/);
  assert.match(infra.metricQuery("memory", [hosts[0]], false, true), /shift:-2h/);
  const fleet = (await infra.queryInfraHealth({}, { value: [] }, fixtureQuery, () => {})).infraReport;
  assert.equal(fleet.topCpu.length, 10);
  assert.equal(fleet.topMemory.length, 10);
  assert.equal(fleet.topCpu[0].name, "host-12");
  assert.equal(fleet.topMemory[0].name, "host-01");
  const selected = (await infra.queryInfraHealth({}, { value: hosts.slice(0, 2) }, fixtureQuery, () => {})).infraReport;
  assert.equal(selected.hostCount, 2);
  assert.equal(selected.selected.length, 2);
  const single = (await infra.queryInfraHealth({}, { value: [hosts[0]] }, fixtureQuery, () => {})).infraReport;
  assert.equal(single.detail.cpu.current.latest, null);
  assert.equal(single.detail.cpu.current.warningBuckets, 2);
  assert.equal(single.detail.cpu.current.criticalBuckets, 1);
  assert.equal(single.detail.cpu.current.missingBuckets, 1);
  const empty = (await infra.queryInfraHealth({}, { value: [hosts[0]] }, async () => [], () => {})).infraReport;
  assert.equal(empty.missingHosts.length, 1);
  assert.equal(empty.detail.cpu.current, null);
  const failed = (await infra.queryInfraHealth({}, { value: [] }, async () => { throw new Error("Forbidden"); }, () => {})).infraReport;
  assert.equal(failed.errors.length, 2);
  assert.equal(failed.cpuCount, 0);
  const partial = (await infra.queryInfraHealth({}, { value: [] }, async (creds, query) => query.includes("dt.host.memory") ? [] : fixtureQuery(creds, query), () => {})).infraReport;
  assert.equal(partial.incompleteHostCount, 12);
  const capped = (await infra.queryInfraHealth({}, { value: [] }, async () => Array.from({ length: 10001 }, (_, index) => ({ id: `HOST-${index.toString(16)}`, average: 60, peak: 70 })), () => {})).infraReport;
  assert.equal(capped.capped, true);
  console.log("PASS: settings defaults, host validation, numeric conversion, severity, rankings, filters, selected scope, trends, missing data, query failures");
  if (process.argv.includes("--unit-only")) return;
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const worker = spawn(require("electron"), [__filename, "--ui-worker"], { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
    const timeout = setTimeout(() => { worker.kill(); reject(new Error("UI worker timed out")); }, 60000);
    worker.once("error", reject);
    worker.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`UI worker exited with code ${code}`)); });
  });
}

if (process.type === "renderer") exposeFixture();
else if (process.argv.includes("--ui-worker")) runUiWorker().catch((error) => { console.error(error); require("electron").app.exit(1); });
else verifyInfra().catch((error) => { console.error(error); process.exitCode = 1; });
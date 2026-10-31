"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const help = require("../src/help");
const checks = require("../src/checks");

const guide = help.readUserGuide();
assert.ok(guide.length > 25000, "Guide should contain detailed, complete documentation");
assert.equal((guide.match(/^## /gm) || []).length, 17);
for (const action of checks.OPERATIONAL_ACTIONS) {
  assert.ok(help.BUTTON_HELP[action.id]?.length > 40, `Missing tooltip for ${action.id}`);
  assert.ok(guide.toLowerCase().includes(action.label.toLowerCase()), `Missing documentation for ${action.label}`);
}
for (const id of ["infra-health", "website-health", "system-health", "guided-triage", "session-health", "impact-scope", "frontend-errors", "slow-pages"]) assert.ok(help.BUTTON_HELP[id]);
const html = help.buildUserGuideHtml(guide, "1.2.1");
assert.match(html, /Version 1\.2\.1/);
assert.match(html, /aria-label="Contents"/);
assert.equal((html.match(/id="guide-topic-/g) || []).length, 17);
assert.equal((html.match(/href="#guide-topic-/g) || []).length, 17);
assert.match(html, /@media print/);
assert.doesNotMatch(html, /<script|<img|<link|src="https?:/i);
assert.doesNotMatch(help.buildUserGuideHtml("# <script>alert(1)</script>", '<img src="secret">'), /<script|<img/i);
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/help.js"), "utf8"), context);
assert.equal(Object.keys(context.window.answersHelp.BUTTON_HELP).length, 20);
async function verifyHelpDownload() {
  const handlers = new Map();
  const writes = [];
  let saveResult = { canceled: false, filePath: "approved-guide.html" };
  let saveOptions;
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const ipcContext = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    readUserGuide: help.readUserGuide,
    buildUserGuideHtml: help.buildUserGuideHtml,
    app: { getVersion: () => "test", getPath: () => "downloads" },
    path,
    mainWindow: {},
    dialog: { showSaveDialog: async (_window, options) => { saveOptions = options; return saveResult; } },
    fs: { writeFileSync: (...args) => writes.push(args) },
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf("function registerIpc("), mainSource.indexOf("function createWindow(")), ipcContext);
  ipcContext.registerIpc();
  assert.equal(handlers.get("help:guide")(), guide);
  const downloaded = await handlers.get("help:download-guide")({}, { content: "Untrusted renderer content" });
  assert.equal(downloaded.canceled, false);
  assert.equal(downloaded.filePath, "approved-guide.html");
  assert.equal(saveOptions.filters[0].extensions[0], "html");
  assert.equal(writes[0][2], "utf8");
  assert.match(writes[0][1], /Dynatrace Answers User Guide/);
  assert.doesNotMatch(writes[0][1], /Untrusted renderer content/);
  saveResult = { canceled: true };
  assert.equal((await handlers.get("help:download-guide")()).canceled, true);
  assert.equal(writes.length, 1, "Canceled download must not write a file");
  saveResult = { canceled: false };
  assert.equal((await handlers.get("help:download-guide")()).canceled, true);
  ipcContext.fs.writeFileSync = () => { throw new Error("Destination unavailable"); };
  saveResult = { canceled: false, filePath: "unavailable.html" };
  await assert.rejects(handlers.get("help:download-guide")(), /Destination unavailable/);
  for (const file of ["circle-help.svg", "download.svg", "x.svg"]) assert.ok(fs.existsSync(path.join(__dirname, "../node_modules/lucide-static/icons", file)), `Missing icon ${file}`);
  console.log("PASS: complete guide, all tooltips, safe offline HTML, local IPC, save/cancel/failure paths and packaged icon assets");
}

async function verifyHelpUi() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = (condition) => new Promise((resolve, reject) => {
    if (condition()) return resolve();
    const observer = new MutationObserver(() => {
      if (condition()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Help UI condition timed out")); }, 10000);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
  await waitFor(() => document.getElementById("helpBtn").dataset.tooltip);
  const helpButton = document.getElementById("helpBtn");
  check(helpButton.nextElementSibling.id === "settingsBtn", "Help must be immediately left of Settings");
  helpButton.focus();
  helpButton.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  const tooltip = document.getElementById("buttonTooltip");
  check(!tooltip.classList.contains("hidden") && tooltip.textContent.includes("offline"), "Keyboard focus must show descriptive tooltip");
  check(helpButton.getAttribute("aria-describedby").includes("buttonTooltip"), "Tooltip must be associated accessibly");
  helpButton.click();
  await waitFor(() => document.querySelectorAll("#helpContent h2").length === 17);
  check(document.getElementById("helpOverlay").classList.contains("hidden") === false, "Help must open");
  check(document.activeElement.id === "closeHelpBtn", "Help must receive keyboard focus");
  check(document.querySelectorAll("#helpTopics option").length === 17, "Every guide section needs topic navigation");
  check(document.getElementById("helpContent").textContent.includes("Session health"), "Guide must explain session consent and checks");
  const topics = document.getElementById("helpTopics");
  topics.value = "guide-topic-15";
  topics.dispatchEvent(new Event("change", { bubbles: true }));
  check(document.activeElement.id === "guide-topic-15", "Topic navigation must focus the selected heading");
  check(document.getElementById("helpContent").scrollTop > 0, "Topic navigation must scroll the guide");
  document.getElementById("downloadUserGuideBtn").click();
  await waitFor(() => document.getElementById("guideDownloadStatus").textContent.includes("User guide saved"));
  check(!document.getElementById("downloadUserGuideBtn").disabled, "Download control must re-enable");
  if (window.fixture?.setGuideDownloadMode) {
    window.fixture.setGuideDownloadMode("cancel");
    document.getElementById("downloadUserGuideBtn").click();
    await waitFor(() => document.getElementById("guideDownloadStatus").textContent === "Download canceled.");
    window.fixture.setGuideDownloadMode("error");
    document.getElementById("downloadUserGuideBtn").click();
    await waitFor(() => document.getElementById("guideDownloadStatus").textContent.includes("download failed"));
    check(!document.getElementById("downloadUserGuideBtn").disabled, "Failed download must re-enable control");
    window.fixture.setGuideDownloadMode("success");
  }
  document.getElementById("closeHelpBtn").focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
  check(document.activeElement.id === "helpContent", "Shift+Tab must stay inside Help");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  check(document.activeElement.id === "closeHelpBtn", "Tab must wrap inside Help");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(document.getElementById("helpOverlay").classList.contains("hidden"), "Escape must close Help");
  check(document.activeElement.id === "helpBtn", "Closing Help must restore focus");
  check(document.documentElement.scrollWidth <= window.innerWidth, "Help must not overflow horizontally");
  return "help placement, complete guide, topic navigation, offline download, cancellation/errors, tooltip accessibility, focus management and layout";
}

module.exports = { verifyHelpUi };
if (require.main === module) verifyHelpDownload().catch((error) => { console.error(error); process.exitCode = 1; });
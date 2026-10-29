"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pdfPath = path.join(root, "dist", "formatting-check.pdf");
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(root, "node_modules/markdown-it/dist/browser/markdown-it.umd.min.js"), "utf8"), context);
context.window.markdownit = context.markdownit;
vm.runInContext(fs.readFileSync(path.join(root, "src/renderer/markdown.js"), "utf8"), context);
const renderMarkdown = context.window.renderMarkdown;

const source = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
const pdfContext = vm.createContext({ sanitizeHtml: require("sanitize-html") });
vm.runInContext(source.slice(source.indexOf("function escapePdfHtml("), source.indexOf("function numericMetric(")), pdfContext);

const sessionTable = (count) => "| Session ID | User tag | Frontend | Errors | Activity |\n| --- | --- | --- | --- | --- |\n" +
  Array.from({ length: count }, (_, index) => `| START${String(index).padStart(3, "0")} | monica | easyTravel_mainframe | 0 | Eight actions and 223 requests END${String(index).padStart(3, "0")} |`).join("\n");

async function renderPdf() {
  const { app, BrowserWindow } = require("electron");
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    const messages = [
      { role: "user", text: "Session health: monica", html: "<p>Session health: monica</p>" },
      { role: "assistant", text: "Session report", html: renderMarkdown("### Session Summary\n\nFound matching sessions for monica. These sample records exercise report pagination.\n\n### Recent sessions\n\n" + sessionTable(60) + "\n\n### Conclusion\n\nAll sample session rows are present in this report.") },
    ];
    const html = pdfContext.buildPdfHtml(messages);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await window.webContents.printToPDF({ pageSize: "A4", printBackground: true, preferCSSPageSize: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, pdf);
  } finally {
    window.destroy();
    app.quit();
  }
}

async function verifyFormatting() {
  for (const count of [1, 5]) {
    const html = renderMarkdown(sessionTable(count));
    assert.match(html, /<table>/);
    assert.equal((html.match(/<td>/g) || []).length, count * 5);
  }
  assert.doesNotMatch(renderMarkdown('<script>alert(1)</script> [link](https://example.com) ![image](file:///test.png)'), /<script>|<a |<img |https:\/\//);
  const sanitized = pdfContext.buildPdfHtml([{ role: "assistant", html: '<details><summary>Additional analysis</summary><p>Preserved analysis</p></details><script>alert(1)</script><img src="https://example.com"><button onclick="alert(1)">Session</button>' }]);
  assert.match(sanitized, /<h4>Additional analysis<\/h4>/);
  assert.match(sanitized, /Preserved analysis/);
  assert.doesNotMatch(sanitized, /<script|<img|onclick|<details/);

  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const worker = spawn(require("electron"), [__filename, "--render-pdf"], { cwd: root, env: environment, stdio: "inherit", windowsHide: true });
    const timeout = setTimeout(() => {
      worker.kill();
      reject(new Error("PDF fixture worker did not finish within 60 seconds"));
    }, 60000);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`PDF worker exited with code ${code}`));
    });
  });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true }).promise;
  try {
    assert.ok(pdf.numPages > 1, "Fixture must exercise multiple pages");
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join(" "));
    }
    assert.match(pages[0], /Session health: monica/);
    assert.match(pages[0], /Session Summary/);
    assert.match(pages[0], /START000/);
    assert.match(pages.at(-1), /Conclusion/);
    for (const page of pages) {
      assert.ok(page.trim().length > 50, "No empty or near-empty PDF pages");
      if (/START\d{3}/.test(page)) assert.match(page, /Session ID/, "Table header must repeat");
    }
    for (let index = 0; index < 60; index++) {
      const marker = String(index).padStart(3, "0");
      const page = pages.find((text) => text.includes(`START${marker}`));
      assert.ok(page, `Missing session row ${index}`);
      assert.ok(page.includes(`END${marker}`), `Session row ${index} split across pages`);
    }
    console.log(`PASS: single/multi-session Markdown, safe PDF HTML, first-page content, ${pdf.numPages} populated pages, repeated headers, 60 intact rows.`);
  } finally {
    await pdf.destroy();
  }
}

if (process.argv.includes("--render-pdf")) {
  renderPdf().catch((error) => { console.error(error); require("electron").app.exit(1); });
} else {
  verifyFormatting().catch((error) => { console.error(error); process.exitCode = 1; });
}
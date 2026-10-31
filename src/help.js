"use strict";

const BUTTON_HELP = {
  "overall-health": "Review observed website, backend, database, host, user-impact and synthetic-monitor evidence. Missing coverage remains unknown.",
  "active-incidents": "List active Dynatrace incidents recorded in the last 30 days, including affected resources and reported impact.",
  "website-health": "Select a website to compare its errors, page-load speed and responsiveness with the previous two hours.",
  "system-health": "Compare errors and page performance across all monitored websites. This checks frontends, not the entire system.",
  "backend-health": "Compare service request volume, failures and average response time across the latest and previous two hours.",
  "database-health": "Review observed database-call errors and latency. Query performance alone does not establish database availability.",
  "infra-health": "Check all hosts or select up to 100. Compare CPU and memory rankings, and select a host for five-minute readings.",
  "guided-triage": "Describe the caller's symptom to investigate frontend error and performance evidence and possible impact scope.",
  "session-health": "Find a user's sessions or investigate an exact session ID. Permission is required before sharing matching session data with AI.",
  "impact-scope": "Choose a reported symptom and compare frontend evidence to see whether one website or several may be affected.",
  "frontend-errors": "Find websites with increasing aggregate error rates and compare their page performance with the previous period.",
  "slow-pages": "Find websites with slow page loads or interactions and check whether errors are increasing at the same time.",
  "who-is-affected": "Review deduplicated observed sessions and browser/device identities with error events. Optionally enter an exact frontend name.",
  "is-it-recovering": "Compare recent backend readings over two 30-minute windows and website readings over two-hour windows. Scope is optional.",
  "application-health": "Select a configured application to check its frontend, entry service and discovered dependencies. Add mappings in Settings.",
  "availability-check": "Review browser and HTTP synthetic-monitor availability. Successful probes do not prove every customer journey works.",
  "what-changed": "Find recorded deployments and configuration changes from the last four hours. An application or incident scope is optional.",
  "capacity-risks": "Review observed host CPU, memory and disk utilization. High averages and brief peaks are distinguished; this is not an exhaustion forecast.",
  "key-transactions": "Select a configured service endpoint to review observed failures and latency. Define transactions in Settings first.",
  "incident-summary": "Collect an evidence-based incident briefing with impact, current status, trends, recorded changes and missing coverage. Scope is optional.",
};

const CONTROL_HELP = {
  newChatBtn: "Clear the visible conversation and start a new investigation. Export any case notes you need before clearing.",
  exportPdfBtn: "Save the visible conversation and report tables as a PDF. Available after a message is present and no answer is running.",
  helpBtn: "Open Help and the complete user guide. Help is available offline without a configured connection.",
  settingsBtn: "Configure the tenant, encrypted token, visible health buttons, application mappings and transaction definitions.",
  sendBtn: "Send your question. Include an application, symptom and time period for a more specific answer.",
  cancelWorkflowBtn: "Close this check without running it.",
  workflowRunBtn: "Run this check using the selected scope. Required selections or session permission must be complete first.",
  closeSettingsBtn: "Close Settings without saving changes.",
  cancelSettingsBtn: "Discard unsaved settings changes and return to the conversation.",
  saveSettingsBtn: "Save connection settings, visible buttons and definitions. A blank token keeps the existing encrypted token.",
  testBtn: "Check connectivity and AI skill access. This does not verify permissions or telemetry for every health check.",
  addApplicationBtn: "Add an application name, exact frontend name and exact entry service name for Application health.",
  addTransactionBtn: "Add a transaction name, exact service name and exact endpoint name for Key transactions.",
  downloadUserGuideBtn: "Save the complete user guide as a self-contained HTML file. Open it offline or use your browser to print it to PDF.",
  closeHelpBtn: "Close Help and return to the control you were using.",
};

const helpContent = { BUTTON_HELP, CONTROL_HELP };

if (typeof module !== "undefined" && module.exports) {
  const fs = require("node:fs");
  const path = require("node:path");
  const MarkdownIt = require("markdown-it");
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const readUserGuide = () => fs.readFileSync(path.join(__dirname, "user-guide.md"), "utf8");
  function buildUserGuideHtml(markdown, version = "") {
    const renderer = new MarkdownIt({ html: false, linkify: false });
    const topics = [];
    renderer.renderer.rules.heading_open = (tokens, index, options, environment, self) => {
      if (tokens[index].tag === "h2") {
        const id = `guide-topic-${topics.length}`;
        topics.push({ id, title: tokens[index + 1].content });
        tokens[index].attrSet("id", id);
      }
      return self.renderToken(tokens, index, options);
    };
    const content = renderer.render(markdown);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Dynatrace Answers User Guide</title><style>
:root{color-scheme:light;font-family:"Segoe UI",sans-serif;color:#182026;background:#f4f6f8}*{box-sizing:border-box}
body{margin:0;line-height:1.65}header,main{max-width:1000px;margin:auto;padding:24px}header{border-bottom:3px solid #007f89}
header p{margin:0;color:#46545f}main{background:#fff}nav{border-bottom:1px solid #cbd5dc;padding-bottom:20px}
nav ol{columns:2;column-gap:32px;padding-left:24px}a{color:#006c78;overflow-wrap:anywhere}h1{font-size:30px;line-height:1.25}
h2{margin-top:36px;font-size:24px;border-bottom:1px solid #cbd5dc;padding-bottom:8px;scroll-margin-top:20px}
h3{font-size:19px;margin-top:24px}h4{font-size:16px}p,li{overflow-wrap:anywhere}code{font-family:Consolas,monospace;font-size:.92em}
table{width:100%;border-collapse:collapse;display:block;overflow-x:auto;font-size:14px}th,td{border:1px solid #cbd5dc;padding:8px;text-align:left;vertical-align:top}
th{background:#edf3f5}blockquote{margin:20px 0;padding:4px 16px;border-left:4px solid #007f89;background:#edf3f5}
@media(max-width:600px){header,main{padding:16px}nav ol{columns:1}h1{font-size:26px}}
@media print{:root,main{background:white}header,main{max-width:none;padding:0}header{margin-bottom:18px}nav{break-after:page}h2,h3,h4{break-after:avoid}table{display:table;font-size:10px}thead{display:table-header-group}tr{break-inside:avoid}a{color:inherit;text-decoration:none}@page{size:A4;margin:18mm}}
</style></head><body><header><p>Dynatrace Answers${version ? ` | Version ${escapeHtml(version)}` : ""} | Offline User Guide</p></header><main>
<nav aria-label="Contents"><h2>Contents</h2><ol>${topics.map((topic) => `<li><a href="#${topic.id}">${escapeHtml(topic.title)}</a></li>`).join("")}</ol></nav>
${content}</main></body></html>`;
  }
  module.exports = { ...helpContent, readUserGuide, buildUserGuideHtml };
} else {
  window.answersHelp = helpContent;
}
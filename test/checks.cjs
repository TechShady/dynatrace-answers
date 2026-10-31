"use strict";

const assert = require("node:assert/strict");
const checks = require("../src/checks");

async function verifyChecks() {
  assert.equal(checks.OPERATIONAL_ACTIONS.length, 12);
  assert.equal(checks.number(null), null);
  assert.equal(checks.number("0"), 0);
  assert.equal(checks.rate(null, 100), null);
  assert.equal(checks.rate(0, 0), null);
  assert.equal(checks.rate(101, 100), null);
  assert.equal(checks.trend(5, 0), "Worse");
  assert.equal(checks.trend(0, 5), "Better");
  assert.equal(checks.trend(null, 5), "Unknown");
  assert.throws(() => checks.normalizeDefinitions({ applications: [{ name: "Shop" }] }));
  const definitions = checks.normalizeDefinitions({ applications: [{ name: "Shop", frontend: "Store", service: "checkout" }] });
  assert.equal(checks.resolveOperationalWorkflow({ id: "application-health", value: "Shop" }, definitions).definition.service, "checkout");
  assert.throws(() => checks.resolveOperationalWorkflow({ id: "key-transactions", value: "Unconfigured" }));
  const malicious = 'service"\n| limit 0';
  assert.ok(checks.serviceQuery(malicious).includes(JSON.stringify(malicious)));
  assert.ok(checks.databaseQuery(malicious).includes(JSON.stringify(malicious)));
  assert.ok(checks.problemQuery(malicious).includes(JSON.stringify(malicious)));
  const summary = checks.summarizeServices([{ "dt.service.name": "api", requests: "100", failures: "5", response_us: "2000000" }], [{ "dt.service.name": "api", requests: "100", failures: "0", response_us: "500000" }])[0];
  assert.equal(summary.responseMs, 2000);
  assert.equal(summary.status, "Critical");
  assert.equal(summary.trend, "Worse");
  assert.equal(checks.summarizeServices([{ requests: "100", response_us: "0" }], [])[0].status, "Unknown");
  const calls = [];
  const workflow = checks.resolveOperationalWorkflow({ id: "backend-health" });
  const result = await checks.queryOperationalHealth({}, workflow, async (_creds, query) => {
    calls.push(query);
    if (query.includes("shift")) throw new Error("Permission denied");
    return [{ "dt.service.name": "api", requests: "100", failures: "0", response_us: "1000" }];
  }, () => {});
  assert.equal(calls.length, 2);
  assert.ok(calls.every((query) => query.includes("dt.service.request")));
  assert.equal(result.operationalReport.status, "Unknown");
  assert.equal(result.operationalReport.services[0].trend, "Unknown");
  for (const action of checks.OPERATIONAL_ACTIONS.filter((item) => !item.definitionType)) {
    const empty = await checks.queryOperationalHealth({}, checks.resolveOperationalWorkflow({ id: action.id }), async () => [], () => {});
    assert.equal(empty.operationalReport.status, "Unknown", `${action.id} must not call no data healthy`);
  }
  console.log("PASS: operational routing, definitions, escaping, thresholds, units, trends, missing data and partial failures");
}

verifyChecks().catch((error) => { console.error(error); process.exitCode = 1; });
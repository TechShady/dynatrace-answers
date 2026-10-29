"use strict";

const HOST_LIMIT = 10000;
const HOST_LIST_DQL = "fetch dt.entity.host\n| fields id, name = entity.name\n| sort name asc\n| limit 10000";

function resolveHosts(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Select up to 100 hosts, or All hosts.");
  const hosts = new Map();
  for (const host of value) {
    if (!host || typeof host.id !== "string" || !/^HOST-[A-F0-9]+$/i.test(host.id)) throw new Error("Invalid host selection.");
    hosts.set(host.id, { id: host.id, name: String(host.name || host.id).slice(0, 500) });
  }
  return [...hosts.values()];
}

function hostFilter(hosts) {
  return hosts.length ? `, filter:{in(dt.entity.host, array(${hosts.map((host) => JSON.stringify(host.id)).join(", ")}))}` : "";
}

function metricQuery(metric, hosts, detail = false, previous = false) {
  const aggregation = detail
    ? `usage = avg(dt.host.${metric}.usage)`
    : `average = avg(dt.host.${metric}.usage, scalar:true), peak = max(dt.host.${metric}.usage, scalar:true)`;
  return `timeseries ${aggregation}, by:{dt.entity.host}, from:now()-2h, to:now(), interval:5m${previous ? ", shift:-2h" : ""}${hostFilter(hosts)}\n` +
    "| fieldsAdd id = dt.entity.host, name = entityName(dt.entity.host, type:\"dt.entity.host\")\n" +
    (detail ? "" : "| sort average desc\n") + `| limit ${HOST_LIMIT + 1}`;
}

function percentage(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function utilizationStatus(average, peak) {
  if (average === null) return "Inconclusive";
  if (average >= 90) return "Critical";
  if (average >= 80) return "Warning";
  return peak !== null && peak >= 80 ? "Spike observed" : "Below threshold";
}

function summarizeMetric(records, selectedHosts) {
  const names = new Map(selectedHosts.map((host) => [host.id, host.name]));
  return records.filter((row) => row.id && (!names.size || names.has(row.id))).map((row) => {
    const average = percentage(row.average);
    const peak = percentage(row.peak);
    return { id: row.id, name: row.name || names.get(row.id) || row.id, average, peak, status: utilizationStatus(average, peak) };
  });
}

function summarizeSeries(records) {
  const row = records[0];
  if (!row || !Array.isArray(row.usage)) return null;
  const samples = row.usage.map(percentage);
  const valid = samples.filter((value) => value !== null);
  return {
    samples,
    interval: row.interval,
    timeframe: row.timeframe,
    latest: samples.at(-1) ?? null,
    observedBuckets: valid.length,
    missingBuckets: samples.length - valid.length,
    warningBuckets: valid.filter((value) => value >= 80).length,
    criticalBuckets: valid.filter((value) => value >= 90).length,
  };
}

async function queryInfraHealth(creds, workflow, runDql, emit) {
  const hosts = workflow.value;
  const errors = [];
  const query = async (label, dql) => {
    emit({ type: "progress", message: `Querying host ${label}...` });
    try { return await runDql(creds, dql, HOST_LIMIT + 1); }
    catch (error) { errors.push(`${label}: ${error.message}`); return []; }
  };
  const cpu = summarizeMetric(await query("CPU", metricQuery("cpu", hosts)), hosts);
  const memory = summarizeMetric(await query("memory", metricQuery("memory", hosts)), hosts);
  const cpuById = new Map(cpu.map((row) => [row.id, row]));
  const memoryById = new Map(memory.map((row) => [row.id, row]));
  const rank = (rows) => rows.filter((row) => row.average !== null).sort((left, right) => right.average - left.average).slice(0, 10);
  const hostIds = new Set([...cpu, ...memory].map((row) => row.id));
  const issues = new Set([...cpu, ...memory].filter((row) => row.average >= 80 || row.peak >= 80).map((row) => row.id));
  const report = {
    scope: hosts.length ? hosts : "All hosts",
    window: "Last two hours",
    generatedAt: new Date().toISOString(),
    thresholds: "Warning: average >=80%; critical: average >=90%. Peaks >=80% are reported as spikes, not sustained saturation.",
    hostCount: hostIds.size,
    issueHostCount: issues.size,
    incompleteHostCount: [...hostIds].filter((id) => cpuById.get(id)?.average == null || memoryById.get(id)?.average == null).length,
    capped: cpu.length > HOST_LIMIT || memory.length > HOST_LIMIT,
    missingHosts: hosts.filter((host) => !hostIds.has(host.id)),
    cpuCount: cpu.filter((row) => row.average !== null).length,
    memoryCount: memory.filter((row) => row.average !== null).length,
    topCpu: rank(cpu),
    topMemory: rank(memory),
    selected: hosts.map((host) => ({ ...host, cpu: cpuById.get(host.id) || null, memory: memoryById.get(host.id) || null })),
    errors,
  };
  if (hosts.length === 1) {
    report.detail = {};
    for (const metric of ["cpu", "memory"]) {
      const current = summarizeSeries(await query(`${metric} five-minute readings`, metricQuery(metric, hosts, true)));
      const previous = summarizeMetric(await query(`${metric} previous period`, metricQuery(metric, hosts, false, true)), hosts)[0] || null;
      report.detail[metric] = { current, previous };
    }
  }
  return {
    infraReport: report,
    supplementary: "Infrastructure CPU/memory health report (percent units). Only assess these resources, not overall host health. " +
      "Rankings are by two-hour average; distinguish transient peaks from sustained load. Missing telemetry is inconclusive. " +
      "Do not infer a process-level cause: process, log, disk, and problem evidence was not collected. " +
      "For a single host explain trends, five-minute breach counts, missing buckets, latest readings, and the previous two-hour comparison. " +
      "For multiple hosts compare their readings and identify the worst affected. Fleet counts may be lower bounds when capped.\n" + JSON.stringify(report),
  };
}

module.exports = { HOST_LIST_DQL, resolveHosts, metricQuery, percentage, utilizationStatus, summarizeMetric, summarizeSeries, queryInfraHealth };
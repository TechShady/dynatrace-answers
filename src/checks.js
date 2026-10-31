"use strict";

const OPERATIONAL_ACTIONS = [
  { id: "overall-health", label: "Overall health", category: "Overview" },
  { id: "active-incidents", label: "Active incidents", category: "Overview" },
  { id: "backend-health", label: "Backend health", category: "Backend" },
  { id: "database-health", label: "Database health", category: "Backend" },
  { id: "who-is-affected", label: "Who is affected?", category: "Investigate", inputLabel: "Frontend application (optional)", optionalInput: true },
  { id: "is-it-recovering", label: "Is it recovering?", category: "Investigate", inputLabel: "Application name or incident ID (optional)", optionalInput: true },
  { id: "application-health", label: "Application health", category: "Overview", inputLabel: "Application", definitionType: "applications" },
  { id: "availability-check", label: "Availability check", category: "Frontend" },
  { id: "what-changed", label: "What changed?", category: "Investigate", inputLabel: "Application name or incident ID (optional)", optionalInput: true },
  { id: "capacity-risks", label: "Capacity risks", category: "Infrastructure" },
  { id: "key-transactions", label: "Key transactions", category: "Backend", inputLabel: "Transaction", definitionType: "transactions" },
  { id: "incident-summary", label: "Incident summary", category: "Investigate", inputLabel: "Application name or incident ID (optional)", optionalInput: true },
];

const OPERATIONAL_INSTRUCTION = "You are Dynatrace Answers, helping nontechnical help desk and executive users. " +
  "Use only the supplied evidence. Start with Status, What's affected, Since when, Better or worse, Next action, and Evidence coverage. " +
  "Use the computed status; unknown or missing telemetry is never healthy. Describe thresholds as screening rules, not SLOs. " +
  "Separate observations, configured mappings, discovered dependencies, and possible causes. Never infer cause from time overlap. " +
  "Do not sum affected-user counts across problems or groups. Observed span counts are sampled records, not total transactions. " +
  "Synthetic availability is probe coverage, not proof every customer transaction works. No recorded changes does not mean no changes occurred. " +
  "Do not invent ownership, database availability, resource limits, onset, recovery, or business impact. " +
  "Never show DQL, URLs, links, or instructions to use Dynatrace or contact an administrator.";

function normalizeDefinitions(input) {
  const normalize = (items, type) => {
    if (items == null) return [];
    if (!Array.isArray(items) || items.length > 50) throw new Error(`Use up to 50 ${type} definitions.`);
    const names = new Set();
    return items.map((item) => {
      const name = String(item?.name || "").trim().slice(0, 200);
      const service = String(item?.service || "").trim().slice(0, 500);
      const field = type === "applications" ? "frontend" : "endpoint";
      const value = String(item?.[field] || "").trim().slice(0, 500);
      if (!name || !service || !value || names.has(name.toLowerCase())) throw new Error(`Each ${type} definition needs a unique name, ${field}, and entry service.`);
      names.add(name.toLowerCase());
      return { name, service, [field]: value };
    });
  };
  return { applications: normalize(input?.applications, "applications"), transactions: normalize(input?.transactions, "transactions") };
}

function resolveOperationalWorkflow(input, definitions = {}) {
  const action = OPERATIONAL_ACTIONS.find((item) => item.id === input?.id);
  if (!action) return null;
  const value = String(input.value || "").trim().slice(0, 500);
  let definition = null;
  if (action.definitionType) {
    definition = definitions[action.definitionType]?.find((item) => item.name === value);
    if (!definition) throw new Error(`Select a configured ${action.definitionType === "applications" ? "application" : "transaction"} in Settings first.`);
  }
  return { ...action, value, definition, question: `${action.label}${value ? `: ${JSON.stringify(value)}` : " across the monitored environment"}. Give an evidence-based operational assessment.` };
}

function exact(field, value) {
  return `${field} == ${JSON.stringify(value)}`;
}

function serviceFilter(service) {
  return Array.isArray(service) ? `in(dt.service.name, array(${service.map((name) => JSON.stringify(name)).join(", ")}))` : exact("dt.service.name", service);
}

function serviceQuery(service, previous = false, recent = false) {
  return "timeseries requests = sum(dt.service.request.count, scalar:true), failures = sum(dt.service.request.failure_count, scalar:true), " +
    "response_us = avg(dt.service.request.response_time, scalar:true), by:{dt.service.name}, " +
    (recent ? "from:now()-30m, to:now()" : "from:now()-2h, to:now()") +
    (previous ? recent ? ", shift:-30m" : ", shift:-2h" : "") +
    (service ? `, filter:{${serviceFilter(service)}}` : "") + "\n| limit 501";
}

function databaseQuery(service, previous = false) {
  return `fetch spans, from:now()-${previous ? "4h" : "2h"}, to:${previous ? "now()-2h" : "now()"}\n` +
    "| filter isNotNull(db.system) or isNotNull(db.system.name)\n" +
    (service ? `| filter ${serviceFilter(service)}\n` : "") +
    "| summarize observed_calls=count(), observed_failures=countIf(span.status_code == \"error\"), failure_coverage=countIf(isNotNull(span.status_code)), " +
    "duration_ns=avg(duration), by:{dt.service.name, db.system, db.system.name, db.name, db.namespace}\n| sort observed_failures desc\n| limit 501";
}

function problemQuery(scope = "", activeOnly = false) {
  return "fetch dt.davis.problems, from:now()-30d, to:now()\n| filter not(dt.davis.is_duplicate)\n" +
    (activeOnly ? "| filter event.status == \"ACTIVE\"\n" : "") +
    (scope ? `| filter ${exact("display_id", scope)} or ${exact("root_cause_entity_name", scope)} or contains(event.name, ${JSON.stringify(scope)}, caseSensitive:false)\n` : "") +
    "| fields event.id, display_id, event.name, event.category, event.status, event.start, event.end, " +
    "root_cause_entity_name, root_cause_entity_id, smartscape.affected_entity.ids, dt.davis.affected_users_count\n| sort event.start desc\n| limit 501";
}

function number(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rate(failures, total) {
  const numerator = number(failures);
  const denominator = number(total);
  return numerator !== null && denominator > 0 && numerator <= denominator ? 100 * numerator / denominator : null;
}

function trend(current, previous) {
  if (current === null || previous === null) return "Unknown";
  const tolerance = Math.max(Math.abs(previous) * 0.1, 0.01);
  return current > previous + tolerance ? "Worse" : current < previous - tolerance ? "Better" : "Similar";
}

function summarizeServices(current, previous) {
  const baseline = new Map(previous.map((row) => [row["dt.service.name"], row]));
  return current.map((row) => {
    const prior = baseline.get(row["dt.service.name"]);
    const errorRate = rate(row.failures, row.requests);
    const response = number(row.response_us);
    const responseMs = response === null ? null : response / 1000;
    const previousResponse = number(prior?.response_us);
    const previousResponseMs = previousResponse === null ? null : previousResponse / 1000;
    const previousErrorRate = rate(prior?.failures, prior?.requests);
    const trends = [trend(errorRate, previousErrorRate), trend(responseMs, previousResponseMs)];
    const status = errorRate === null || responseMs === null ? "Unknown"
      : errorRate >= 5 || responseMs >= 2000 ? "Critical" : errorRate >= 1 || responseMs >= 1000 ? "Warning" : "Below screening thresholds";
    return { name: row["dt.service.name"] || "Unnamed service", requests: number(row.requests), failures: number(row.failures), errorRate, responseMs,
      previousErrorRate, previousResponseMs, status, trend: trends.includes("Worse") ? "Worse" : trends.includes("Unknown") ? "Unknown" : trends.includes("Better") ? "Better" : "Similar" };
  });
}

function impactQuery(frontend, grouped = false) {
  return "fetch user.events, from:now()-2h, to:now()\n| filter frontend.type == \"web\" and dt.rum.user_type == \"real_user\"\n" +
    (frontend ? `| filter ${exact("frontend.name", frontend)}\n` : "") +
    "| summarize observed_sessions=countDistinctExact(dt.rum.session.id), error_sessions=countDistinctExact(if(characteristics.has_error == true, dt.rum.session.id, else:null)), " +
    "observed_instances=countDistinctExact(dt.rum.instance.id), error_instances=countDistinctExact(if(characteristics.has_error == true, dt.rum.instance.id, else:null)), " +
    "error_events=countIf(characteristics.has_error == true), events=count(), identity_events=countIf(isNotNull(dt.rum.instance.id))" +
    (grouped ? ", by:{frontend.name, geo.country.iso_code, device.type}" : "") + "\n| limit 501";
}

function changeQuery(scope = "") {
  return "fetch dt.davis.events, from:now()-4h, to:now()\n" +
    "| filter in(event.type, array(\"CUSTOM_DEPLOYMENT\", \"CUSTOM_CONFIGURATION\", \"DEPLOYMENT\", \"CONFIGURATION_CHANGE\"))\n" +
    (scope ? `| filter ${exact("dt.service.name", scope)} or ${exact("entity.name", scope)} or contains(event.name, ${JSON.stringify(scope)}, caseSensitive:false)\n` : "") +
    "| fields event.start, event.name, event.type, dt.service.name, entity.name\n| sort event.start desc\n| limit 501";
}

function transactionQuery(definition, previous = false) {
  return `fetch spans, from:now()-${previous ? "4h" : "2h"}, to:${previous ? "now()-2h" : "now()"}\n` +
    `| filter request.is_root_span == true and ${exact("dt.service.name", definition.service)} and ${exact("endpoint.name", definition.endpoint)}\n` +
    "| summarize observed_calls=count(), observed_failures=countIf(request.is_failed == true), failure_coverage=countIf(isNotNull(request.is_failed)), duration_ns=avg(duration), p95_ns=percentile(duration, 95)";
}

function hostQuery(metric, hosts = []) {
  return `timeseries average=avg(${metric}, scalar:true), peak=max(${metric}, scalar:true), by:{dt.smartscape.host}, from:now()-2h, to:now(), interval:5m` +
    (hosts.length ? `, filter:{in(dt.smartscape.host, array(${hosts.map((id) => `toSmartscapeId(${JSON.stringify(String(id))})`).join(", ")}))}` : "") +
    "\n| fieldsAdd name=getNodeName(dt.smartscape.host)\n| sort average desc\n| limit 501";
}

async function collectApplicationScope(collect, definition, report) {
  const roots = await collect("Application entry service mapping", `smartscapeNodes \"SERVICE\"\n| filter ${exact("name", definition.service)}\n| fields id, name, type\n| limit 501`);
  let frontier = roots.map((row) => String(row.id));
  const seen = new Set(frontier);
  const nodes = [...roots];
  const links = [];
  for (let hop = 0; hop < 3 && frontier.length; hop++) {
    const ids = frontier.map((id) => `toSmartscapeId(${JSON.stringify(id)})`).join(", ");
    const edges = await collect(`Application dependencies hop ${hop + 1}`, `smartscapeEdges \"*\"\n| filter in(source_id, array(${ids})) and in(type, array(\"calls\", \"runs_on\", \"belongs_to\"))\n| fields source_id, target_id, type, target_type\n| limit 501`, false);
    links.push(...edges);
    frontier = [...new Set(edges.filter((edge) => ["SERVICE", "DATABASE", "HOST", "PROCESS", "PROCESS_GROUP_INSTANCE", "K8S_POD", "CONTAINER"].includes(edge.target_type))
      .map((edge) => String(edge.target_id)).filter((id) => !seen.has(id)))].slice(0, 100);
    frontier.forEach((id) => seen.add(id));
    if (frontier.length) {
      const targets = await collect(`Application dependency names hop ${hop + 1}`, `smartscapeNodes \"*\"\n| filter in(id, array(${frontier.map((id) => `toSmartscapeId(${JSON.stringify(id)})`).join(", ")}))\n| fields id, name, type\n| limit 501`);
      nodes.push(...targets);
    }
    if (edges.length >= 500 || frontier.length >= 100) report.incomplete = true;
  }
  report.applicationMapping = { ...definition, nodes, links };
  report.sections.push({ title: "Configured application and discovered dependencies", columns: ["Resource", "Type", "Mapping"], rows: nodes.map((row) => [row.name, row.type, roots.includes(row) ? "Configured entry service" : "Observed topology dependency"]) });
  report.notes.push("Application membership starts from its configured frontend and entry service; topology explores up to three forward hops and 100 targets per hop. This is bounded coverage, not a complete dependency inventory.");
  if (!roots.length || !nodes.some((row) => row.type === "HOST")) report.incomplete = true;
  return { services: [...new Set([definition.service, ...nodes.filter((row) => row.type === "SERVICE").map((row) => row.name)])], hosts: nodes.filter((row) => row.type === "HOST").map((row) => String(row.id)) };
}

async function queryOperationalHealth(creds, workflow, runDql, emit, context = {}) {
  const sources = [];
  const collect = async (label, dql, emptyIsUnknown = true) => {
    emit({ type: "progress", message: `Checking ${label.toLowerCase()}...` });
    try {
      const records = await runDql(creds, dql, 501);
      sources.push({ label, status: records.length ? "Available" : emptyIsUnknown ? "Unknown" : "No matching records", count: records.length, capped: records.length >= 501, records: records.slice(0, 500) });
      return records.slice(0, 500);
    } catch (error) {
      sources.push({ label, status: "Unknown", count: 0, capped: false, error: String(error.message || error), records: [] });
      return [];
    }
  };
  const report = { id: workflow.id, title: workflow.label, scope: workflow.value || "Monitored environment", generatedAt: new Date().toISOString(),
    window: "Latest two hours compared with the previous two hours", status: "Unknown", sources, sections: [],
    notes: ["Screening thresholds are not configured SLOs. Missing or incomplete telemetry is unknown.", "The earliest recorded incident is not necessarily the start of user impact."] };
  report.assessments = [];
  let applicationScope = null;
  if (workflow.id === "application-health") applicationScope = await collectApplicationScope(collect, workflow.definition, report);
  const configured = context.definitions?.applications?.find((item) => item.name.toLowerCase() === workflow.value.toLowerCase());
  let scopedName = configured?.service || workflow.value;
  if (/^P-\d+$/i.test(workflow.value)) {
    const incidents = await collect("Selected incident", problemQuery(workflow.value), false);
    scopedName = incidents.find((row) => row.display_id === workflow.value)?.root_cause_entity_name || "Unresolved incident resource";
    report.notes.push("Incident metrics are scoped to its reported root-cause resource name, not all affected dependencies. Unmapped resources have unknown coverage.");
    report.selectedIncident = incidents;
  }
  const service = applicationScope?.services || workflow.definition?.service || scopedName || undefined;
  const frontend = workflow.definition?.frontend || configured?.frontend || (workflow.value && !/^P-\d+$/i.test(workflow.value) ? workflow.value : undefined);
  if (["overall-health", "application-health", "is-it-recovering", "incident-summary"].includes(workflow.id)) {
    if (context.frontendQuery && context.summarizeFrontend) {
      const current = await collect("Website experience", context.frontendQuery + (frontend ? `, filter:{${exact("frontend.name", frontend)}}` : "") + "\n| limit 501");
      const previous = await collect("Website previous period", context.frontendQuery + ", shift:-2h" + (frontend ? `, filter:{${exact("frontend.name", frontend)}}` : "") + "\n| limit 501");
      const baseline = new Map(previous.map((row) => [row["frontend.name"], row]));
      report.frontends = current.map((row) => context.summarizeFrontend(row, baseline.get(row["frontend.name"])));
      report.assessments.push(...report.frontends.map((row) => ({ healthy: "Below screening thresholds", degraded: "Warning", watch: "Warning", inconclusive: "Unknown" })[row.health_status] || "Unknown"));
      report.sections.push({ title: "Website experience", columns: ["Website", "Error %", "Previous error %", "Page load p75 ms", "Previous page load ms", "Interaction p75 ms", "Previous interaction ms", "Status"],
        rows: report.frontends.map((row) => [row.frontend_name, row.current_error_rate_percent, row.previous_error_rate_percent, row.current_lcp_p75_ms, row.previous_lcp_p75_ms, row.current_inp_p75_ms, row.previous_inp_p75_ms, row.health_status]) });
      report.notes.push("Website page load uses p75 LCP (good <=2,500ms, poor >4,000ms); interaction uses p75 INP (good <=200ms, poor >500ms). Aggregate frontend errors are not specifically JavaScript errors.");
    } else report.incomplete = true;
  }
  if (["backend-health", "overall-health", "application-health", "is-it-recovering", "incident-summary"].includes(workflow.id)) {
    const current = await collect("Backend services", serviceQuery(service));
    const previous = await collect("Backend previous period", serviceQuery(service, true));
    report.services = summarizeServices(current, previous);
    report.sections.push({ title: "Backend services", columns: ["Service", "Requests", "Failures", "Error %", "Response ms", "Previous error %", "Previous response ms", "Status", "Trend"],
      rows: report.services.map((row) => [row.name, row.requests, row.failures, row.errorRate, row.responseMs, row.previousErrorRate, row.previousResponseMs, row.status, row.trend]) });
    report.notes.push("Service screening: error rate >=1% or average response >=1,000ms is warning; >=5% or >=2,000ms is critical.");
  }
  if (["database-health", "overall-health", "application-health"].includes(workflow.id)) {
    const current = await collect("Database calls", databaseQuery(service));
    const previous = await collect("Database previous period", databaseQuery(service, true));
    const key = (row) => JSON.stringify([row["dt.service.name"], row["db.system"] || row["db.system.name"], row["db.namespace"] || row["db.name"]]);
    const prior = new Map(previous.map((row) => [key(row), row]));
    report.databases = current.map((row) => {
      const baseline = prior.get(key(row));
      const errorRate = number(row.failure_coverage) === number(row.observed_calls) ? rate(row.observed_failures, row.observed_calls) : null;
      const duration = number(row.duration_ns);
      const durationMs = duration === null ? null : duration / 1e6;
      const previousDuration = number(baseline?.duration_ns);
      const previousDurationMs = previousDuration === null ? null : previousDuration / 1e6;
      return { name: row["db.namespace"] || row["db.name"] || "Unnamed database", system: row["db.system.name"] || row["db.system"], service: row["dt.service.name"],
        calls: number(row.observed_calls), errorRate, durationMs, previousDurationMs, trend: trend(durationMs, previousDurationMs),
        status: errorRate === null || durationMs === null ? "Unknown" : errorRate >= 5 || durationMs >= 2000 ? "Critical" : errorRate >= 1 || durationMs >= 1000 ? "Warning" : "Below screening thresholds" };
    });
    report.sections.push({ title: "Observed database calls", columns: ["Database", "Technology", "Calling service", "Observed spans", "Error %", "Average ms", "Previous average ms", "Status", "Latency trend"],
      rows: report.databases.map((row) => [row.name, row.system, row.service, row.calls, row.errorRate, row.durationMs, row.previousDurationMs, row.status, row.trend]) });
    report.notes.push("Database calls are sampled spans, not total operations. Error rates describe only observed spans with status codes. Query performance does not establish database uptime, locks, connections, or server resource capacity. Screening uses the same latency/error rules as services.");
  }
  if (["active-incidents", "overall-health", "database-health", "application-health", "is-it-recovering", "incident-summary", "what-changed", "availability-check"].includes(workflow.id)) {
    report.problems = report.selectedIncident || await collect("Recorded incidents (30 days)", problemQuery(workflow.definition?.service || scopedName, workflow.id === "active-incidents"), false);
    report.sections.push({ title: "Recorded incidents", columns: ["Incident", "Issue", "Category", "State", "Started", "Ended", "Reported root cause", "Affected users (per incident)"],
      rows: report.problems.map((row) => [row.display_id, row["event.name"], row["event.category"], row["event.status"], row["event.start"], row["event.end"], row.root_cause_entity_name, row["dt.davis.affected_users_count"]]) });
    report.notes.push("Incident coverage is limited to records in the last 30 days. A category is not a severity level; ownership is unknown unless explicitly supplied. User counts across incidents may overlap.");
  }
  if (["who-is-affected", "overall-health", "application-health", "incident-summary"].includes(workflow.id)) {
    const totals = await collect("Observed user impact totals", impactQuery(frontend));
    const groups = await collect("Observed user impact by website and location", impactQuery(frontend, true));
    report.impact = totals[0] || null;
    report.sections.push({ title: "Observed user impact (deduplicated totals)", columns: ["Observed sessions", "Sessions with error events", "Observed browser/device identities", "Identities with error events", "Error events"],
      rows: totals.map((row) => [row.observed_sessions, row.error_sessions, row.observed_instances, row.error_instances, row.error_events]) });
    report.sections.push({ title: "Impact by website, location and device", columns: ["Website", "Country", "Device", "Observed sessions", "Sessions with errors", "Identities with errors"],
      rows: groups.map((row) => [row["frontend.name"], row["geo.country.iso_code"], row["device.type"], row.observed_sessions, row.error_sessions, row.error_instances]) });
    report.assessments.push(number(totals[0]?.events) > 0 ? number(totals[0]?.error_events) > 0 ? "Warning" : "Below screening thresholds" : "Unknown");
    report.notes.push("Impact describes real-user error events in the last two hours, not every kind of user difficulty. Browser/device identities are not distinct people. Group counts overlap; only the totals query deduplicates across groups. No individual identifiers are returned.");
  }
  if (["what-changed", "incident-summary"].includes(workflow.id)) {
    const changes = await collect("Recorded deployments and configuration changes (4 hours)", changeQuery(scopedName), false);
    report.changes = changes;
    report.sections.push({ title: "Recorded changes in the last four hours", columns: ["Time", "Change", "Type", "Service", "Resource"], rows: changes.map((row) => [row["event.start"], row["event.name"], row["event.type"], row["dt.service.name"], row["entity.name"]]) });
    report.notes.push("Only explicitly recorded deployment/configuration event types are included. Absence of records does not prove nothing changed. Time overlap with an incident is not evidence of cause; older incident changes may fall outside this window.");
  }
  if (workflow.id === "is-it-recovering") {
    const current = await collect("Recovery latest 30 minutes", serviceQuery(service, false, true));
    const previous = await collect("Recovery preceding 30 minutes", serviceQuery(service, true, true));
    report.recovery = summarizeServices(current, previous);
    report.sections.push({ title: "Backend recovery: latest 30 minutes versus preceding 30 minutes", columns: ["Service", "Error %", "Previous error %", "Response ms", "Previous response ms", "Trend"],
      rows: report.recovery.map((row) => [row.name, row.errorRate, row.previousErrorRate, row.responseMs, row.previousResponseMs, row.trend]) });
    report.notes.push("Improving backend readings do not prove incident resolution. Website comparisons still use two-hour windows. Confirm recovery for all affected resources and user journeys.");
  }
  if (["capacity-risks", "overall-health", "application-health"].includes(workflow.id)) {
    const hosts = applicationScope?.hosts || [];
    if (workflow.id !== "application-health" || hosts.length) {
      for (const [label, metric] of [["CPU", "dt.host.cpu.usage"], ["Memory", "dt.host.memory.usage"], ["Disk used", "dt.host.disk.used.percent"]]) {
        const records = await collect(`Host ${label}`, hostQuery(metric, hosts));
        const rows = records.map((row) => {
          const average = number(row.average);
          const peak = number(row.peak);
          const status = average === null || average > 100 ? "Unknown" : average >= 90 ? "Critical" : average >= 80 || peak >= 80 ? "Warning" : "Below screening thresholds";
          report.assessments.push(status);
          return [row.name || row["dt.smartscape.host"], average, peak, status];
        });
        report.sections.push({ title: `${label} utilization`, columns: ["Host", "Two-hour average %", "Peak %", "Status"], rows });
      }
    }
    report.notes.push("Host averages >=80% are warning and >=90% critical; peaks >=80% flag transient load. Disk is aggregated by host and may hide a full individual volume. These checks do not predict exhaustion time, inspect every database resource limit, or establish process-level causes.");
  }
  if (["availability-check", "overall-health"].includes(workflow.id)) {
    for (const [label, metric, dimension] of [["Browser probes", "dt.synthetic.browser.availability", "dt.entity.synthetic_test"], ["HTTP probes", "dt.synthetic.http.availability", "dt.entity.http_check"]]) {
      const records = await collect(label, `timeseries availability=avg(${metric}, scalar:true), by:{${dimension}}, from:now()-2h, to:now()\n| fieldsAdd name=entityName(${dimension})\n| limit 501`);
      const rows = records.map((row) => {
        const availability = number(row.availability);
        const status = availability === null || availability > 100 ? "Unknown" : availability < 95 ? "Critical" : availability < 99 ? "Warning" : "Below screening thresholds";
        report.assessments.push(status);
        return [row.name || row[dimension], availability, status];
      });
      report.sections.push({ title: label, columns: ["Monitor", "Availability %", "Status"], rows });
    }
    report.notes.push("Synthetic screening: availability <99% is warning and <95% critical. Browser and HTTP probe coverage may differ; missing probes are unknown. Probe success does not prove login, checkout or every location works.");
  }
  if (workflow.id === "key-transactions") {
    const current = await collect("Configured transaction", transactionQuery(workflow.definition));
    const previous = await collect("Configured transaction previous period", transactionQuery(workflow.definition, true));
    const observed = current[0];
    const prior = previous[0];
    const errorRate = number(observed?.failure_coverage) === number(observed?.observed_calls) ? rate(observed?.observed_failures, observed?.observed_calls) : null;
    const previousRate = number(prior?.failure_coverage) === number(prior?.observed_calls) ? rate(prior?.observed_failures, prior?.observed_calls) : null;
    const duration = number(observed?.duration_ns);
    const durationMs = duration === null ? null : duration / 1e6;
    const status = errorRate === null || durationMs === null ? "Unknown" : errorRate >= 5 || durationMs >= 2000 ? "Critical" : errorRate >= 1 || durationMs >= 1000 ? "Warning" : "Below screening thresholds";
    report.assessments.push(status);
    report.transaction = { ...workflow.definition, status, errorRate, previousRate, trend: trend(errorRate, previousRate) };
    report.sections.push({ title: "Configured transaction endpoint", columns: ["Transaction", "Service", "Endpoint", "Observed spans", "Error %", "Previous error %", "Average ms", "p95 ms", "Trend"],
      rows: [[workflow.definition.name, workflow.definition.service, workflow.definition.endpoint, number(observed?.observed_calls), errorRate, previousRate, durationMs, number(observed?.p95_ns) === null ? null : number(observed.p95_ns) / 1e6, report.transaction.trend]] });
    if (report.transaction.trend === "Unknown") report.incomplete = true;
    report.notes.push("A transaction definition matches one instrumented service endpoint exactly, not a complete multi-step business journey. Counts and latency are observed sampled root spans; they are not total business completions or revenue. Screening uses service latency/error rules.");
  }
  const statuses = [...(report.services || []), ...(report.databases || [])].map((row) => row.status);
  if (report.problems?.some((row) => row["event.status"] === "ACTIVE")) statuses.push("Warning");
  if (report.assessments) statuses.push(...report.assessments);
  const incomplete = sources.some((source) => source.status === "Unknown" || source.capped) || statuses.includes("Unknown") || report.incomplete;
  report.status = statuses.includes("Critical") ? "Critical" : statuses.includes("Warning") ? "Needs attention"
    : incomplete || !statuses.length ? "Unknown" : "No issues in observed checks";
  report.coverageIncomplete = Boolean(incomplete);
  const trends = [...(report.recovery || report.services || []).map((row) => row.trend), ...(report.databases || []).map((row) => row.trend),
    ...(report.frontends || []).flatMap((row) => [trend(row.current_error_rate_percent, row.previous_error_rate_percent), trend(row.current_lcp_p75_ms, row.previous_lcp_p75_ms), trend(row.current_inp_p75_ms, row.previous_inp_p75_ms)]),
    ...(report.transaction ? [report.transaction.trend] : [])];
  report.trend = trends.includes("Worse") ? "Worse" : !trends.length || trends.includes("Unknown") ? "Unknown" : trends.includes("Better") ? "Better" : "Similar";
  report.nextAction = report.status === "Critical" || report.status === "Needs attention" ? "Escalate the affected resources with the evidence below; check the responsible team's incident process."
    : report.status === "Unknown" || report.coverageIncomplete ? "Confirm the missing monitoring coverage before ruling out an issue."
    : "Continue monitoring the observed checks; this does not certify all systems or user journeys.";
  let rowLimit = 10;
  let supplementary;
  do {
    supplementary = OPERATIONAL_INSTRUCTION + "\n" + JSON.stringify({ title: report.title, scope: report.scope, generatedAt: report.generatedAt, window: report.window,
      status: report.status, trend: report.trend, nextAction: report.nextAction, coverageIncomplete: report.coverageIncomplete, notes: report.notes,
      sources: sources.map(({ records, ...source }) => source), sections: report.sections.map((section) => ({ ...section, rows: section.rows.slice(0, rowLimit), omittedRows: Math.max(0, section.rows.length - rowLimit) })) });
    rowLimit = Math.floor(rowLimit / 2);
  } while (supplementary.length > 15000 && rowLimit > 0);
  return { operationalReport: report, supplementary };
}

const healthChecks = { OPERATIONAL_ACTIONS, OPERATIONAL_INSTRUCTION, normalizeDefinitions, resolveOperationalWorkflow, serviceQuery, databaseQuery, problemQuery, impactQuery, changeQuery, transactionQuery, hostQuery, number, rate, trend, summarizeServices, queryOperationalHealth };
if (typeof module !== "undefined" && module.exports) module.exports = healthChecks;
else window.healthChecks = healthChecks;
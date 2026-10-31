# Dynatrace Answers User Guide

For help desk staff, business leaders, application owners, and other teams who need understandable answers from monitored-system evidence.

## 1. What This App Does

Dynatrace Answers is a Windows desktop application that reads monitoring data from your organization's Dynatrace environment and presents operational findings in a conversation. Health-check buttons collect specific evidence without requiring you to write queries or navigate Dynatrace. You can also ask questions in your own words.

Use the app to establish what the available evidence shows, which resources might need attention, and what to include in a handoff. It is not a replacement for your organization's incident-management process or the judgment of the team responsible for an application.

The app supports:

- Website errors, page-load performance, and responsiveness.
- Backend service request volume, failures, and response times.
- Observed database-call performance and failures.
- Host CPU, memory, and disk-utilization checks.
- Recorded incidents, recorded changes, and recovery comparisons.
- Aggregate user-impact evidence and permission-based session investigations.
- Configured applications and configured critical service endpoints.
- PDF case notes and an offline copy of this guide.

The app reads monitoring data. It does not restart services, modify infrastructure, deploy changes, open tickets, acknowledge incidents, or resolve problems. Saving settings changes only this app's local configuration.

**Important:** A healthy-looking answer is limited to the evidence actually collected. An empty result, missing measurements, inaccessible data, or an unmapped application does not establish that everything is healthy.

## 2. First-Time Setup

### Installation and connection

1. Install the Windows application using your organization's approved installer.
2. Open Dynatrace Answers from its desktop or Start menu shortcut.
3. Open **Settings** in the top-right corner.
4. Enter the **Tenant URL**, identifying the Dynatrace environment you are authorized to investigate.
5. Enter an authorized **Platform token**. This is a sensitive credential; do not paste it into the conversation or a support case.
6. Select **Test connection** to check connectivity and AI skill access.
7. Select **Save** to keep the configuration.
8. Run a relevant health check and read its coverage notes before relying on the result.

The expected tenant format is `https://your-environment.apps.dynatrace.com`. A classic `.live.dynatrace.com` hostname is normalized to the apps hostname when settings are saved. The app uses the environment origin, rather than a pasted page path.

Connection testing does not prove every check has permission to read its data. A token can support chat while lacking access to metrics, spans, sessions, or topology. A successful connection also does not prove that an application is instrumented or that synthetic monitoring is configured.

### Updating the saved token

The platform token is encrypted using Windows secure storage. Once a token is saved, the Settings token field stays blank. Leave it blank to keep the current token, or enter a replacement token to change it.

Do not copy encrypted settings between users or machines expecting the credential to work. Secure-storage availability depends on the Windows user and environment. Follow your organization's credential and token-rotation procedures.

Settings, visible-button choices, and application/transaction definitions persist across restarts. Older settings are migrated from the app's previous name when appropriate. Unsaved changes are discarded when you close or cancel Settings.

Changing the saved tenant URL clears the visible conversation so a previous environment's results are not mistaken for the new environment's evidence. Export needed notes before changing environments.

### If you do not manage connection credentials

Use the connection provisioned by your organization's app owner. Do not request broader access simply to remove an unknown status. The appropriate monitoring or security team should determine which environment and data your role may access.

Help and this user guide are available without a configured tenant, a valid token, or a network connection.

## 3. Finding Your Way Around

### Header controls

| Control | Purpose |
| --- | --- |
| Connection status | Shows whether the app is configured or whether a recent request reported a connection/authentication issue. It is not a system-health indicator. |
| Version | Identifies the installed application version for support and change tracking. |
| New chat | Clears the visible investigation and starts a new conversation. Export any notes you need first. |
| Export PDF | Saves the visible messages and report tables as PDF case notes. The button is disabled when the conversation is empty or an answer is running. |
| Help icon | Opens this guide and the offline-download control. |
| Settings | Opens connection settings, button visibility, application mappings, transaction definitions, and data mode. |

Hover over a button to see what it does. Keyboard focus also exposes its explanation. A tooltip describes the purpose of a control; it is not a health result.

### Health-check categories

**Overview** contains common starting points. **Frontend** focuses on customer-facing websites and availability probes. **Backend** contains service, database, and configured-transaction checks. **Infrastructure** contains host resource checks. **Investigate** contains symptom, impact, session, recovery, change, and summary workflows.

Some common checks appear in Overview and their specialist category. They run the same workflow in either location. Settings lets you hide individual checks; hidden checks are also omitted from applicable follow-up actions. Hiding a button does not remove monitoring data or change a token's permissions.

If a category has no enabled checks, it is omitted. If you hide every check, you can still ask a question and reopen Settings to restore the buttons.

### Conversation and input

The conversation contains your questions, structured reports, and AI analysis. Type a question in the message box and select **Send**. Press **Enter** to send, or **Shift+Enter** to add a new line.

While an answer is running, Send, New chat, and the health-check controls are temporarily disabled to avoid overlapping investigations. Progress messages describe the data being collected. The app does not automatically refresh completed reports.

## 4. A Reliable Investigation Workflow

1. Establish the caller's application, symptom, approximate onset, and whether the issue is ongoing.
2. Start with **Active incidents**, **Website health**, or **Guided triage**, depending on what is known.
3. Select a specific application or resource whenever a picker is available.
4. Read the status and coverage together. Identify which signals are actually available.
5. Review the affected resources and the current-versus-previous measurements.
6. Use a narrower check or an in-app resource link to investigate further.
7. Record observations separately from suspected explanations.
8. Escalate through your organization's normal process when evidence or business impact warrants it.
9. Export the conversation as PDF when you need case notes or a handoff.

For executives, **Overall health** is a starting summary, not a certification of all systems. Follow it with **Active incidents** or **Incident summary**, and include coverage gaps in any briefing.

For help desk staff, a caller's real difficulty remains relevant even when monitoring is inconclusive. Absence of recorded errors does not invalidate the report of a broken page, failed login, or intermittent issue.

## 5. Understanding Status, Time, and Coverage

### Structured operational reports

New operational checks start with a consistent set of information:

| Field | How to read it |
| --- | --- |
| Status | The assessment supported by the observed measurements and incidents. |
| What's affected | The selected scope or monitored environment being assessed. Review the evidence tables for individual resources. |
| Since when | An observed incident time when available. The earliest recorded active incident is not necessarily the onset of user impact. |
| Better or worse | A comparison of current and previous measurements. Unknown means a meaningful comparison could not be made. |
| Next action | A recommended operational follow-up, not an automated remediation. |
| Evidence coverage | Which sources returned records, when the check ran, and what period it covers. |

Expand an evidence section to see its measurements. Expand **Coverage and assessment rules** for missing sources, result caps, and interpretation rules. **Additional analysis** contains the AI explanation; the structured measurements are still important if that explanation is unavailable.

### Status terminology

- **Critical:** At least one observed resource meets a critical screening threshold. Review the affected row and coverage; this is not automatically the incident priority assigned by your organization.
- **Needs attention:** Observed warnings or active incident evidence warrant review.
- **No issues in observed checks:** The collected checks did not identify a screening issue. This is narrower than saying every system is healthy.
- **Unknown:** Missing, incomplete, inaccessible, or insufficient evidence prevents a reliable assessment.
- **Coverage incomplete:** Some evidence is missing or capped, even if another source establishes a warning or critical finding.

Existing frontend checks may use **healthy**, **watch**, **degraded**, or **inconclusive**. Existing Infra Health tables may use **Below threshold**, **Warning**, **Critical**, **Spike observed**, or **Inconclusive**. These labels describe the specific signals in those reports, not a universal application-health certification.

### Time windows and comparisons

Most metric checks compare the latest **two hours** with the preceding **two hours**. Recovery also compares backend measurements from the latest **30 minutes** with the preceding **30 minutes**. Recorded-change evidence covers **four hours**. Incident lookups cover records in the latest **30 days**, while existing frontend workflows use recent incident context from their shorter window.

Session analysis uses a different window: user-tag lookup covers **seven days**; an exact session-ID lookup can search **30 days**. Always read the window actually shown in your report.

An answer is a snapshot, not a live dashboard. Running a check again collects fresh evidence. A natural-language question can request a different period, but standard health buttons use their built-in windows.

### Screening rules are not business SLOs

The app uses fixed screening rules to make findings understandable. These rules are not a substitute for your application's configured service-level objectives or business priorities. A change of approximately 10% or more is used by the newer operational trend comparisons, with a small absolute tolerance around zero. A meaningful metric getting worse can dominate the combined trend.

Below-threshold results can still coincide with a real business issue, especially when a workflow, user segment, resource, or location is not covered.

## 6. Overview and Incident Checks

### Overall health

**Use it for:** An initial cross-domain summary of the monitored environment.

The check collects website error/performance comparisons, backend service metrics, observed database calls, recorded incidents, aggregated user-impact evidence, host CPU/memory/disk utilization, and synthetic availability evidence. Review the domain tables to see where the finding originates.

Overall health does not guarantee every application, database server, host volume, region, or business journey is covered. Missing synthetic monitors, missing traces, or incomplete topology can leave important gaps. A critical observed resource can still be reported while overall coverage is incomplete.

### Active incidents

**Use it for:** Finding currently active Dynatrace-detected problems.

The report lists active incidents represented by records in the last 30 days, with their identifier, title, category, state, recorded start/end times, reported root cause, and affected-user count when available. Select an incident identifier in a structured report to request its summary.

An incident category such as availability, error, slowdown, or resource is not a severity level. The app does not assign or invent team ownership. Older active problems outside the record window, permission restrictions, or monitoring gaps may limit coverage. Do not add affected-user counts across incidents; the same users may appear in more than one.

### Application health

**Use it for:** A scoped view of a configured business application.

Select an application definition created in Settings. The definition supplies an exact frontend name and an exact entry service name. The app checks that frontend and explores forward topology from the entry service to identify additional services and hosting resources where available. Database evidence concerns calls from the scoped services.

Discovery is bounded to three forward hops, up to 100 targets per hop, and capped query results. The report distinguishes configured membership from discovered dependencies. An exact name match is not a complete dependency map. Unresolved entry services, absent hosts, inaccessible topology, or incomplete instrumentation reduce confidence.

Application health does not infer that an unrelated service belongs to the application simply because its name looks similar. Configure the mapping carefully and review discovered resources before using the result in an executive summary.

## 7. Frontend and Website Checks

### Website health

**Input:** Select an exact frontend from the searchable picker.

**Use it for:** Checking the website a caller or business stakeholder actually named.

The check uses that frontend's own metrics, including error rate, error counts, page-load performance, and interaction responsiveness. It compares the latest two hours with the prior two hours. A frontend is not classified as healthy or missing merely because it is absent from a top-ranking list.

If the picker is empty or cannot load, the token may lack metric access, the frontend may have no recent request telemetry, or the name may belong to a different environment. Refine the search or verify the intended frontend with the monitoring owner.

### All websites health

**Use it for:** Determining whether frontend errors or performance issues are concentrated in one website or spread across several.

This is the frontend-only check formerly called System health. It does not assess every backend, database, or infrastructure component. Compare error rates and page-performance readings across frontends rather than relying solely on raw error totals.

### Frontend errors

**Use it for:** Identifying websites with the largest error-rate increases.

The result pairs aggregate frontend error trends with page-performance measurements. Aggregate error counts are not specifically JavaScript exceptions. More traffic can produce more errors without increasing the error rate, so read request volume and the rate comparison together.

### Slow pages

**Use it for:** Finding slow page loads or unresponsive interactions.

The current check ranks frontend-level page-load and interaction measurements. Despite its short label, it does not provide a URL-by-URL page inventory. Review errors alongside performance to see whether both are degraded.

**LCP** measures when the largest main content becomes visible. **INP** measures how quickly the page responds to interaction. The reported p75 value represents a percentile, not the average experience of every user.

| Website measure | Good range | Needs improvement | Poor range |
| --- | --- | --- | --- |
| Page load: p75 LCP | Up to 2,500 ms | Above 2,500 to 4,000 ms | Above 4,000 ms |
| Interaction: p75 INP | Up to 200 ms | Above 200 to 500 ms | Above 500 ms |

Frontend error rate above the 1% review threshold warrants attention. Missing current error-rate, LCP, or INP evidence makes frontend health inconclusive; missing prior readings limits comparison confidence.

### Availability check

**Use it for:** Reviewing browser and HTTP synthetic-monitor success.

Synthetic monitors are automated probes. The check summarizes their observed availability over the latest two hours. Availability below 99% is a warning screening signal; below 95% is critical.

Browser and HTTP probes can cover different applications, locations, schedules, and steps. A missing probe is unknown, not successful. Successful probes do not prove that every real user can log in, complete checkout, make a payment, or use every region. Availability depends on configured monitors and supported telemetry in your environment.

## 8. Backend, Database, and Transaction Checks

### Backend health

**Use it for:** Checking whether instrumented services are slow or failing.

The report compares request volume, failed requests, error rate, and average response time for the latest two hours and the previous two hours. Service response times are displayed in milliseconds. Select a service name in a structured backend table to run a narrower service check.

Warning screening begins at a 1% error rate or a 1,000 ms average response time. Critical screening begins at 5% or 2,000 ms. A missing failure count is not treated as zero. No requests or missing measurements can prevent a reliable error-rate calculation.

Service averages can hide a slow endpoint or small affected group. Use a configured transaction check when a critical endpoint matters, and do not interpret a request count as the number of distinct users.

### Database health

**Use it for:** Reviewing the performance of observed database calls made by instrumented services.

The report groups observed calls by database identity/technology and calling service, comparing average latency with the previous period. It reports observed failure evidence only when status-code coverage is sufficient.

Database rows come from trace spans. These are observed, potentially sampled records, not the total number of database operations. Call latency is converted to milliseconds. The current screening uses the same 1%/5% failure-rate and 1,000/2,000 ms latency rules as services.

This check does not establish database-server uptime, connection-pool capacity, locks, replication health, storage headroom, or a process-level root cause. A database can be unavailable without producing usable call telemetry, and a slow call does not prove which server resource caused it. Review relevant incident evidence and escalate uncertain database availability through the responsible team's process.

### Key transactions

**Input:** Select a named transaction definition saved in Settings.

**Use it for:** Checking one important instrumented service endpoint, such as the login endpoint or payment authorization endpoint.

The definition matches an exact service name and exact endpoint name. The check summarizes observed root-span failures, average latency, p95 latency, and comparison evidence from the prior two hours. Missing failure flags or an empty endpoint result remain unknown.

A named endpoint is not a complete multi-step business journey. Successful endpoint spans do not establish business completion, revenue, order fulfillment, or successful use of all related pages. Counts are observed sampled spans, not guaranteed total transactions.

## 9. Infrastructure and Capacity Checks

### Infra Health

**Input:** All hosts by default, or a searchable selection of up to 100 hosts.

**Use it for:** Comparing host CPU and memory utilization.

Separate top-10 CPU and memory tables rank two-hour average utilization and show peaks. A host can rank highly for one resource but not another. For multiple selected hosts, the report compares their readings directly.

1. Open Infra Health.
2. Keep **All hosts** selected to check the monitored fleet, or search for a host.
3. Select the host checkbox; repeat searches to add more hosts. Selections survive search changes.
4. Select **Run check**.
5. Select a host-name link in the result to request a single-host deep dive.

A single-host deep dive includes five-minute readings, observed warning/critical buckets, latest readings, missing buckets, and a comparison with the previous two-hour average. Selecting All hosts clears specific selections.

CPU and memory averages of at least 80% are warnings; at least 90% are critical. Peaks of at least 80% are reported separately as spikes and do not by themselves establish sustained saturation.

The host picker and fleet queries are capped at 10,000 hosts per query. Capped reports disclose incomplete coverage and lower-bound counts. Missing CPU or memory data makes the relevant assessment inconclusive. This check alone does not establish overall infrastructure health or identify the process responsible.

### Capacity risks

**Use it for:** Reviewing observed host CPU, memory, and disk utilization together.

The operational report summarizes two-hour averages and peaks. It uses 80% average as warning and 90% average as critical, and flags high transient peaks separately. Missing resource metrics remain unknown.

Disk evidence is aggregated by host and may hide a full individual volume. This check does not calculate time until exhaustion, predict future traffic, inspect every database resource limit, or recommend automatic resizing. Treat it as resource-pressure evidence that may need a more detailed infrastructure investigation.

## 10. Help Desk and User-Impact Checks

### Guided triage

**Input:** Describe what the caller reported.

Examples include a slow banking homepage, a broken submit button, or a page becoming unresponsive after sign-in. Include the application, approximate time, and whether other users are affected when known. Avoid credentials and unnecessary personal details.

The current workflow checks fleet frontend error and page-performance evidence. It distinguishes confirmed observations from possible overlap with recent incidents. It cannot establish a backend, deployment, or user-specific cause without corresponding evidence.

### Impact scope

**Input:** Select one of the listed symptoms, such as slow page load, failed requests, login trouble, or missing content.

The check compares frontend error/performance evidence to assess whether the issue appears concentrated or widespread. The symptom is investigation context, not proof that a specific error type occurred. Aggregate frontend measurements do not establish how many distinct people were affected.

### Who is affected?

**Input:** Optionally enter an exact frontend name. Leave it blank for monitored web frontends.

The check uses real-user events from the latest two hours to count observed sessions, sessions with error events, browser/device identities, and identities with error events. It also groups evidence by website, country, and device.

The separate totals query deduplicates across groups. Do not add grouped counts together: a session or identity can appear in multiple groups. Browser/device identities are not confirmed distinct people, because cookies, browsers, devices, or privacy settings can alter identity coverage.

The check concerns observed error events, not every kind of user difficulty. Missing identity fields limit identity counts. It returns aggregate evidence rather than individual user tags or session identifiers.

### Session health

**Input:** A user identifier/tag, an exact session ID, or both. You must confirm permission before running the check.

1. Open Session health.
2. Enter an authorized user identifier/tag or the session ID you are investigating.
3. If entering both, ensure they are intended to refer to the same user session.
4. Confirm permission to share identifiers and matching session data with Dynatrace Intelligence.
5. Run the check and read the lookup/matching status first.
6. Review the summary, most recent or selected session, and recent-session records.
7. Select a session ID in the result for a narrower investigation; permission must be confirmed again.

Tag-only lookup searches matching sessions from the last seven days, covering all matches up to the result cap. An exact session-ID lookup can search up to 30 days. A summary may deep-dive the newest matching session and display the latest five session IDs; the detailed matching list is capped at 500.

No match does not establish a healthy session. The supplied tag may be absent, the timeframe may be wrong, the identifiers may not match the same session, or the token may lack access. Session records can be delayed while a session is active and before aggregation finishes, so very recent activity may not yet appear.

The app does not record a session replay or perform automated remediation. Do not use another person's session information without a legitimate purpose and the required permission.

## 11. Recovery, Changes, and Briefings

### Is it recovering?

**Input:** Optionally enter a configured application name, resource name, or incident identifier. Blank input requests a monitored-environment comparison.

The check compares recent backend measurements across two 30-minute windows, alongside broader two-hour backend and frontend evidence. An improving measurement is not equivalent to incident closure or restored business functionality. Review all affected resources and user journeys before declaring recovery.

A configured application name resolves to its configured frontend and entry service. An incident scope uses its reported root-cause resource name for metric checks; it is not automatically an inventory of every affected dependency. A resource that cannot be mapped to frontend/service telemetry may return unknown evidence. Arbitrary names are exact/name-based scopes, not guaranteed cross-domain application mappings.

### What changed?

**Input:** An optional application name, resource name, or incident ID.

The report retrieves explicitly recorded deployment and configuration-change event types from the latest four hours and provides incident context. It does not inspect a complete audit trail or infer a deployment from a latency increase.

No matching change records does not prove no change occurred. An incident may have started before the four-hour change window, and your environment may record changes using event types not covered by this check. A nearby change is correlation, not proof of cause.

### Incident summary

**Input:** An optional application name, resource name, or incident identifier.

Use this to produce a concise briefing based on recorded incidents, service/frontend trends, aggregate user impact, and recorded changes. Read the structured evidence and missing-coverage notes before sharing the AI explanation.

A useful handoff includes the selected scope, observed incident identifiers, time window, confirmed symptoms, observed impact, trend, missing evidence, and responsible team's next step. Do not turn an unknown cause into a confirmed cause when copying the summary into a case.

The app does not create a ticket or send the summary to a team. Use your approved communication process.

## 12. Configuring Applications and Transactions

### Application mappings

1. Open Settings and locate **Application mappings**.
2. Select the add (+) button.
3. Enter a unique **Application name**: the friendly name shown in the selector.
4. Enter the **Exact frontend name** used in your environment's frontend telemetry.
5. Enter the **Exact entry service name** used in service telemetry and topology.
6. Select Save, then run Application health for the new definition.
7. Review the discovered dependencies and coverage before relying on the mapping.

The entry service should be the intended application's monitored starting service, not a guessed database or unrelated similarly named service. Definitions contain one frontend and one entry service; additional dependencies are discovered where supported. Each list supports up to 50 definitions.

### Key transaction definitions

1. Open Settings and locate **Key transaction definitions**.
2. Select the add (+) button.
3. Enter a unique **Transaction name**, such as Payment authorization.
4. Enter the **Exact service name** that receives the request.
5. Enter the **Exact endpoint name** as reported in monitored root spans.
6. Select Save, then run Key transactions for the definition.

Names are exact matching values, not wildcards or free-text descriptions. A URL path is only correct if it is also the monitored endpoint name. Ask the application/monitoring owner to confirm the appropriate values. Incomplete definitions and duplicate friendly names cannot be saved. Use the remove (-) button to delete a definition, then Save to persist the change.

No configured definitions means the relevant selector has nothing to run. The workflow explains that definitions must be added in Settings; it does not silently substitute an unrelated application or transaction.

## 13. Asking Questions in Your Own Words

Prefer a focused question with a clear scope, symptom, and timeframe. For example:

- "For the Customer Portal, are errors or page-load times worse in the last two hours?"
- "Which backend services show increased failures compared with the previous two hours?"
- "Summarize the observed impact for this incident and separate known facts from missing evidence."
- "What does the current host report show about sustained CPU load versus short spikes?"
- "Based on the results already collected, what should I include in a help desk handoff?"

The **Data mode** setting determines whether free-text questions collect environment data. When enabled, the app can use AI-generated queries for natural-language requests, subject to available skills, permissions, and supported data. Health-check buttons always collect their dedicated evidence, even when Data mode is off.

With Data mode off, a free-text answer is not automatically a fresh environment assessment. Follow-up conversation context is also not proof that measurements were refreshed. For a repeatable built-in check, use its button.

AI can misunderstand names, requested periods, or intent. Verify the returned scope, time period, measurements, and coverage before acting. If the answer does not match the question, restate the scope or run a specific health check. Use New chat when starting an unrelated investigation.

## 14. Case Notes and the Offline Guide

### Exporting a conversation to PDF

1. Complete the investigation or wait for the current answer to finish.
2. Select Export PDF.
3. Choose an approved folder and filename in the save dialog.
4. Review the PDF before attaching it to a case or sending it to someone else.

The export includes visible questions, answers, structured tables, additional analysis, and message timestamps. Interactive controls become printable content rather than live investigations. It does not export a continuously updating dashboard.

Exported notes can contain host names, application names, incident details, user identifiers, session IDs, and other sensitive telemetry present in the conversation. Treat the PDF according to your organization's data-handling policy. New chat clears the visible conversation, not files you already exported.

### Downloading this guide

1. Select the Help icon to the left of Settings.
2. Select **Download user guide**.
3. Choose where to save the HTML file.
4. Open the file in a browser when you need the guide offline.
5. To obtain a PDF copy, use the browser's Print command and choose its PDF destination.

The downloaded file includes the complete guide, a contents list, print styling, and the installed app version. It has no external assets, scripts, tenant details, saved token, conversation, or collected telemetry. The same packaged guide is used inside Help and for the download.

Opening Help or downloading the guide does not send a question to AI or make a monitoring query. Canceling the save dialog leaves the conversation unchanged.

## 15. Privacy, Access, and AI

### What is sent for an answer

Health-check results and relevant context are sent to Dynatrace Intelligence to explain the evidence. Data-mode free-text requests may also generate queries and send query results for analysis. Those results can contain sensitive operational values even when no user identifier was entered.

Session health requires explicit permission because identifiers and matching session data are shared for analysis. Aggregated impact checks do not return individual user tags or session IDs. Do not enter passwords, access tokens, payment details, or unnecessary personal information in a question or definition.

### Local configuration and exported files

The token is encrypted locally through Windows secure storage. Other settings, such as the tenant URL, visible buttons, and application/transaction mappings, are local configuration and should not be assumed to have the same encryption protection as the credential.

Exported PDF notes are ordinary files. This guide's download contains documentation only. Use approved storage locations for case notes and follow retention policies. Do not include a token or a raw credential in a troubleshooting screenshot.

### Permission reference for app owners

Your token owner needs the appropriate Dynatrace policies as well as token scopes. Available data, bucket access, configured monitoring, and enabled AI skills also affect results.

| Permission area | Typical use |
| --- | --- |
| `davis-copilot:conversations:execute` | AI conversation and evidence explanation. |
| `davis-copilot:nl2dql:execute` | Query generation for free-text data questions; dedicated health buttons do not rely on this for their fixed queries. |
| `storage:buckets:read` | Grail bucket access, alongside the relevant data-type permissions. |
| `storage:metrics:read` | Website, service, host, and synthetic metrics. |
| `storage:entities:read` | Entity names and host/service entity access. |
| `storage:smartscape:read` | Application topology and Smartscape resource naming. |
| `storage:spans:read` | Observed database calls and configured transaction endpoints. |
| `storage:events:read` | Incident and recorded-change evidence where required by the environment. |
| `storage:user.events:read` | Real-user event evidence and aggregate impact counts. |
| `storage:user.sessions:read` | Matching session summaries and session investigations. |
| `storage:logs:read`, `storage:bizevents:read`, `storage:system:read`, `storage:security.events:read` | Additional data sources that may be requested through data-mode questions. |

This is a reference, not a recommendation to grant every scope. Grant only the access needed for the user's role. A readable data type does not necessarily mean every bucket or record is accessible.

## 16. Troubleshooting

| What you see | What it may mean | Practical next step |
| --- | --- | --- |
| Not configured | No saved tenant or token is available. | Open Settings and complete the authorized connection configuration. Help remains available. |
| Authentication error, 401, or 403 | A token is expired, invalid, or lacks permission, or the owner lacks a required policy. | Check the intended environment and approved access with the connection owner; replace the token through Settings if authorized. |
| Connected, but a check is unknown | Chat works, but the data source may be inaccessible, empty, unsupported, or incompletely instrumented. | Read the specific coverage/source message rather than treating connection success as full access. |
| No matching frontend | No recent matching request metrics, a different environment/name, or insufficient permissions. | Confirm the exact monitored frontend and tenant; refine the picker search. |
| No application or transaction options | No definitions have been saved. | Add complete definitions in Settings or ask the app owner to provision them. |
| No matching database or endpoint records | There may be no observed instrumented calls in the window, missing spans, a wrong exact name, or inaccessible data. | Verify the definition and coverage; do not infer successful operation from silence. |
| Session not found | Wrong tag/ID, mismatched identifiers, absent user tagging, an older session, or aggregation delay. | Verify the authorized identifiers and displayed search window. |
| A few rows are missing or a cap is reached | Results exceed the workflow's record limit. | Use a narrower scope and disclose incomplete coverage in the handoff. |
| Trend is unknown | A current or previous metric cannot be compared reliably. | Check which reading is missing; do not call an issue recovering on that basis. |
| No changes recorded | The four-hour window or covered event types contain no matches. | Do not claim there were no deployments or configuration changes. |
| Additional AI analysis unavailable | Evidence collection succeeded, but AI explanation failed. | Use the structured operational/infra report and its coverage notes; retry only when needed. |
| Export PDF is disabled | The conversation is empty or an answer is running. | Wait for completion or collect a message/report first. |
| Guide download fails | The save location is inaccessible, full, or unavailable. | Choose an approved writable location and try again. Help can still display the guide. |
| A report looks healthy but the caller still has trouble | The issue may be outside collected monitoring, intermittent, segment-specific, or not represented by the screening rules. | Preserve the caller's evidence and investigate/escalate the missing scope. |

When seeking support, include the app version, check name, selected scope, approximate time, and non-sensitive error text. Do not send the token. Reproduce the issue with an approved, narrow scope when practical.

## 17. Glossary and Handoff Checklist

| Term | Plain-language meaning |
| --- | --- |
| Frontend | The website or user-facing application experience. |
| Backend service | A monitored service that processes requests behind the application. |
| Database call | An observed request from a service to a database, not proof of the database's total workload. |
| Host | A monitored machine providing computing resources. |
| Telemetry | Measurements and events collected by monitoring. |
| Error rate | Failed/error counts divided by an appropriate request count, expressed as a percentage. |
| Latency / response time | How long an observed operation takes. |
| p75 / p95 | Percentile readings; approximately 75% / 95% of the represented observations fall at or below the value. |
| Synthetic monitor | An automated probe that checks configured availability or steps. |
| Span | A recorded part of a traced operation. Sampling means observed span counts may not equal total operations. |
| Incident / problem | A Dynatrace-detected issue represented by recorded problem evidence. |
| Root cause | A cause attributed by the supplied evidence; a nearby event is not automatically the cause. |
| Scope | The application, user, session, service, host, incident, or fleet included in the check. |
| Baseline / previous period | The comparison window used to assess whether a metric changed. |
| Coverage | How much of the needed evidence was actually available and usable. |
| SLO | A defined service-level objective; fixed app screening thresholds are not the same thing. |

Before sharing an answer, confirm:

- The tenant and selected scope are correct.
- The time window and report timestamp are visible.
- Confirmed findings are separated from possible explanations.
- Unknown, missing, delayed, or capped evidence is disclosed.
- User-impact counts are not summed across overlapping groups or incidents.
- Improving telemetry is not described as full recovery without supporting evidence.
- The case notes contain only information the recipient is authorized to receive.
- The next action follows your organization's incident and privacy processes.
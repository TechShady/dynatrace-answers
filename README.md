# Dynatrace Answers

Operational insights for every team, powered by Dynatrace Intelligence.

A Windows desktop application for help desk staff, executives, and other teams who need answers from Dynatrace without navigating its UI.

## Install

Download the Windows installer and SHA-256 checksum from the [latest release](https://github.com/TechShady/dynatrace-answers/releases/latest).

The installer creates Dynatrace Answers desktop and Start menu shortcuts. Existing settings are copied into the renamed application's settings folder on first launch when no new settings exist. Platform tokens remain encrypted using the operating system's secure storage.

Configure the tenant and platform token in Settings. Query access depends on the token's permissions. Session analysis requires explicit consent before sharing identifiers and matching session data with Dynatrace Intelligence.

## Capabilities

- Ask operational questions using natural language.
- Check frontend health, errors, page performance, and user impact.
- Analyze matching sessions and open individual session investigations.
- Enable or hide individual health check buttons in Settings; choices are saved across restarts.
- Check Infra Health for all hosts or a searchable selection of up to 100 hosts. Separate top-10 CPU and memory tables rank two-hour average utilization and include peaks. Host-name links run an in-app deep dive with five-minute readings and the previous two-hour comparison.
- Export formatted answers and session tables to PDF case notes.

Infrastructure checks require `storage:metrics:read`, `storage:entities:read`, and `storage:buckets:read`, plus the conversation scope for additional AI analysis. CPU/memory averages at 80% are warnings and at 90% are critical; transient peaks are labeled separately. Missing telemetry is inconclusive, not healthy. Fleet results and the searchable host list are capped at 10,000 hosts per query; capped reports disclose incomplete coverage. These checks do not establish process-level causes or overall infrastructure health.

## Development

Use Node.js 22.13 or later and Windows for installer builds.

```sh
npm ci
npm start
npm test
npm run dist
```

The infrastructure tests cover settings persistence, rankings, scoped queries, missing data, thresholds, and synthetic Electron picker/drill-down interactions. Run `node test/infra.cjs --unit-only` for backend checks without launching Electron. The formatting test generates a synthetic PDF in the ignored build directory and checks table rendering, safe HTML export, first-page content, repeated headers, and intact table rows. Tagged releases build the installer and publish its checksum through GitHub Actions.
# Dynatrace Answers

Operational insights for every team, powered by Dynatrace Intelligence.

A Windows and macOS desktop application for help desk staff, executives, and other teams who need answers from Dynatrace without navigating its UI.

## Install

Download the installer and SHA-256 checksum for your platform from the [latest release](https://github.com/TechShady/dynatrace-answers/releases/latest):

- Windows: `Dynatrace-Answers-Setup-VERSION.exe`.
- Mac with an Apple Silicon chip (M-series): `Dynatrace-Answers-VERSION-macOS-arm64.dmg`.
- Mac with an Intel processor: `Dynatrace-Answers-VERSION-macOS-x64.dmg`.

On macOS, check Apple menu > About This Mac to identify the chip or processor. Open the matching DMG, drag Dynatrace Answers to Applications, then eject the disk image and launch the installed app.

**Unsigned macOS builds:** No Apple Developer account is configured, so these DMGs are unsigned and unnotarized. After verifying the source and checksum, macOS may require System Settings > Privacy & Security > Open Anyway following a blocked launch. Follow your organization's policies; managed Macs may forbid unnotarized applications. Do not disable Gatekeeper globally. Signing and notarization can be added later with an authorized Apple Developer identity.

The Windows installer creates Dynatrace Answers desktop and Start menu shortcuts. Existing settings are copied into the renamed application's settings folder on first launch when no new settings exist. Platform tokens remain encrypted using the operating system's secure storage (Windows secure storage or macOS Keychain); credentials do not transfer between operating systems. On macOS, closing the window leaves the app running; reopen it from the Dock, or use Command-Q to quit.

Configure the tenant and platform token in Settings. Query access depends on the token's permissions. Session analysis requires explicit consent before sharing identifiers and matching session data with Dynatrace Intelligence.

## Capabilities

- Ask operational questions using natural language.
- Check frontend health, errors, page performance, and user impact.
- Run grouped operational checks for backend services, observed database calls, incidents, recovery, recorded changes, synthetic availability, capacity, and configured applications/transactions. Missing telemetry remains unknown; screening rules are not business SLOs.
- Analyze matching sessions and open individual session investigations.
- Enable or hide individual health check buttons in Settings; choices are saved across restarts.
- Check Infra Health for all hosts or a searchable selection of up to 100 hosts. Separate top-10 CPU and memory tables rank two-hour average utilization and include peaks. Host-name links run an in-app deep dive with five-minute readings and the previous two-hour comparison.
- Export formatted answers and session tables to PDF case notes.
- Hover or focus buttons for descriptive tooltips. Open the Help icon immediately left of Settings for the complete user guide and topic navigation.
- Download a self-contained offline HTML user guide from Help. It includes contents links and print styling for browser PDF output; reading/downloading it never queries Dynatrace or sends data to AI.

## User Guide

The complete [user guide](src/user-guide.md) explains all 20 checks, setup and permissions, time windows and thresholds, evidence coverage, session consent, application mappings, exact transaction definitions, exports, privacy, and troubleshooting. Help and its download use this same packaged document. Application health and Key transactions require definitions in Settings; their scopes are not guessed from friendly names.

Infrastructure checks require `storage:metrics:read`, `storage:entities:read`, and `storage:buckets:read`, plus the conversation scope for additional AI analysis. CPU/memory averages at 80% are warnings and at 90% are critical; transient peaks are labeled separately. Missing telemetry is inconclusive, not healthy. Fleet results and the searchable host list are capped at 10,000 hosts per query; capped reports disclose incomplete coverage. These checks do not establish process-level causes or overall infrastructure health.

## Development

Use Node.js 22.13 or later. Build Windows installers on Windows and DMGs on macOS.

```sh
npm ci
npm start
npm test
npm run dist
```

On macOS, use `npm run dist:mac` for both DMG architectures, or `npm run dist:mac -- --arm64` / `npm run dist:mac -- --x64` for one architecture. GitHub Actions runs tests and native builds on Windows, Apple Silicon macOS, and Intel macOS, then publishes all installers and checksums together only when all platform jobs succeed.

The infrastructure tests cover settings persistence, rankings, scoped queries, missing data, thresholds, and synthetic Electron picker/drill-down interactions. Run `node test/infra.cjs --unit-only` for backend checks without launching Electron. The formatting test generates a synthetic PDF in the ignored build directory and checks table rendering, safe HTML export, first-page content, repeated headers, and intact table rows. Tagged releases build the installer and publish its checksum through GitHub Actions.

Run `node test/help.cjs` for guide completeness, all health-button tooltip descriptions, safe offline HTML, local guide IPC, save/cancel/error handling, and packaged icon assets. Help navigation, download feedback, keyboard tooltips, focus trapping, and focus restoration are also exercised by the Electron UI fixture.
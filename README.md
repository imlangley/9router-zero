# 9Router WYx0

WYx0 fork of 9Router focused on provider automation, multi-account workflows, and quota tracking for coding agents.

This repository is forked from [decolua/9router](https://github.com/decolua/9router). The upstream project remains the base AI router. This fork documents and ships the WYx0 changes on top: Kiro automation, CodeBuddy automation, Qoder automation, quota tracker upgrades, and small dashboard quality-of-life updates.

## Focus

- Kiro bulk login automation with browser-assisted Google account flow.
- CodeBuddy bulk login automation with CLI-state polling and saved OAuth connections.
- Qoder bulk login automation with browser-assisted Google SSO and device-token polling.
- CodeBuddy quota tracking through the web console usage endpoint when a valid web session cookie is available.
- Quota Tracker improvements, including provider pagination and single-account/bulk display modes.
- Provider UX polish: CodeBuddy icon, provider icon fallback, Discord link, connection status filtering, and related dashboard updates.
- Safer provider workflows: token refresh handling, account fallback, request detail compaction, and focused tests around the new automation paths.

## What Changed In This Fork

### Automation

- Added `/dashboard/automation` as the entry point for bulk provider workflows.
- Added Kiro bulk import routes and services for browser-based account onboarding.
- Added CodeBuddy bulk import routes and services, including CLI authorization polling.
- Added Qoder bulk import routes and services, reusing Qoder's device-token OAuth flow instead of direct database writes.
- Added reusable browser automation helpers for Google login, provider onboarding, region selection, privacy prompts, and manual follow-up.

### Quota Tracking

- Added CodeBuddy to supported usage providers.
- Added CodeBuddy quota parsing for credit packages such as monthly, gift, extra, and activity credits.
- Added a CodeBuddy "Quota Cookie" flow so existing OAuth connections can attach a web console cookie for usage reads.
- Added Quota Tracker pagination and a display mode switch for single-account versus bulk provider views.

### Provider And Dashboard Polish

- Added CodeBuddy visual assets and provider icon fallback behavior.
- Added a Discord shortcut in the header pointing to [dsc.gg/wyxhub](https://dsc.gg/wyxhub).
- Improved connection status utilities and provider table ergonomics for automation-heavy workflows.
- Added supporting tests for Kiro/CodeBuddy/Qoder import managers, route behavior, connection status, and account fallback.

## CodeBuddy Quota Note

CodeBuddy chat uses the plugin/CLI OAuth token, but the CodeBuddy credit usage endpoint is part of the web console and requires a valid web session cookie. New CodeBuddy bulk automation attempts to capture that cookie during browser login. Existing connections can attach it from:

`Dashboard -> Providers -> CodeBuddy -> select connection -> Quota Cookie`

If the cookie is missing or expired, the connection can still chat, but quota tracking will show a clear message instead of fake usage numbers.

## Local Development

```bash
cp .env.example .env
npm install
npm run dev
```

Default local URLs:

- Dashboard: `http://localhost:20128/dashboard`
- OpenAI-compatible API: `http://localhost:20128/v1`
- Automation: `http://localhost:20128/dashboard/automation`
- Quota Tracker: `http://localhost:20128/dashboard/quota`

Production build:

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

## Verification

Recommended checks before opening a PR:

```bash
npm run build
```

Focused unit tests may be run when the local test setup is available:

```bash
npm test -- kiro
npm test -- codebuddy
npm test -- qoder
```

## Panel CI/CD

This fork includes `.github/workflows/panel-deploy.yml`, which builds the Next.js standalone panel on GitHub Actions and deploys the prebuilt artifact to the Pelican panel VPS on every push to `master`.

Configure these GitHub repository secrets before enabling push-triggered deploys:

- `PANEL_SSH_HOST`: VPS host, for example `4.145.116.181`.
- `PANEL_SSH_USER`: SSH user, for example `userlang`.
- `PANEL_SSH_KEY`: private SSH key that can connect to the VPS and run the required `sudo -n` deployment commands.

The workflow preserves runtime data on the panel volume, including `.9router`, `.env`, `.cache`, `.playwright-libs`, `.npm`, and existing `node_modules`, then restarts the panel container and checks `https://ai.langley.page/api/health`.

## PR Scope

This fork's current PR scope is intentionally centered on WYx0 changes:

- Add Kiro automation.
- Add CodeBuddy automation.
- Add Qoder automation.
- Add CodeBuddy quota usage support.
- Add quota tracker pagination and bulk/single view behavior.
- Update README and metadata to describe this fork instead of the upstream product pitch.

## Upstream Credit

9Router WYx0 builds on the original 9Router project by decolua. Keep upstream credit and license notices intact when redistributing or merging changes.

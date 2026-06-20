# Changelog

All notable changes to this plugin will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - 2026-06-20
### Added
- 6 new rows in the priced model table to cover the rest of OpenAI's published per-token list (developers.openai.com/api/docs/pricing, 2026-06-20 fetch): `gpt-5-4-pro` ($30 / $180 — same shape as `gpt-5-5-pro`), `chat-latest` ($5 / $30), `computer-use-preview` ($1.50 / $6), `o3-deep-research` ($5 / $20), `o4-mini-deep-research` ($1 / $4), `o4-mini` ($4 / $16, used as the fallback target for date-stamped fine-tuning snapshots like `o4-mini-2025-04-16`).
- `normalizeModel` now strips ISO date snapshot suffixes (`-YYYY-MM-DD`) before re-running exact match, and recognises the o-series family (o3 / o4 with optional `-mini` and optional `-deep-research`). The host audit on the live Paperclip instance shows no OpenAI events yet — this widening is preemptive, not in response to broken pricing in production. Each row is documented inline against the upstream price doc.

### Fixed
- `CSV_MODEL_LABELS` was a fork artifact — it still carried the Claude Opus/Sonnet labels from the original `claude-token-cost-reports` fork point. CSV exports would have mislabeled OpenAI model columns the moment the export route was used. Replaced with the correct GPT-5 / o-series labels.

### Note
- Cached-input pricing (a separate column on the upstream page, ~10% of the input rate for most models) is NOT currently tracked per-event by this plugin. Operators with a high cache-hit ratio can override the input rate in Settings to reflect their effective blended rate. Full cached-input modelling is tracked for the operator-extensible matrix work (2.0.0).

## [1.0.1] - 2026-06-20
### Changed
- README: Install section now documents the install / uninstall slug asymmetry. The npm package is scoped (`@herrhelms/…`) but the in-app plugin key is not, so install uses `@herrhelms/openai-token-cost-reports` while uninstall uses `openai-token-cost-reports`.

## [1.0.0] - 2026-06-20

First GA release on the npm registry. Folds the rc.1 / rc.2 staging history into one published release; the pre-publish audit pass from the Claude sibling plugin (`@herrhelms/claude-token-cost-reports@1.0.0`) was mirrored here, plus the 1.0.1 SDK-bundling fix from that same plugin's first install.

### Fixed
- BLOCKER: `rollupCompanyDay` rewritten as a single `INSERT … SELECT … ON CONFLICT DO UPDATE` so concurrent cron + live ingest can't race to lose tokens.
- BLOCKER: CSV `/export/monthly.csv` rejects `from`/`to` query strings that aren't strict `YYYY-MM-DD`. Prevents header injection via crafted query string.
- BLOCKER: CSV cells are RFC 4180-escaped; values containing comma / quote / CRLF are quoted with internal quotes doubled.
- BLOCKER: FX rates from `open.er-api.com` are now bounded to `0.01..1000`. Outlier values are logged and skipped instead of persisted.
- BLOCKER: Worker bundle now includes `@paperclipai/plugin-sdk` instead of treating it as external. Without this, `paperclipai plugin install` from npm fails at first worker spawn with `ERR_MODULE_NOT_FOUND`.
- Archive cleanup now purges the per-company pricing config from `ctx.state` (alongside the currency state it already purged).
- `isPricingConfig` rejects `margin.percent` that is NaN, negative, or above 500.
- `rollup-daily` cron now re-rolls today AND yesterday on each tick. Catches midnight-boundary late events and recovers from partial-failure live ingests.
- Per-event ingest log demoted from `info` to `debug`. Stops dumping per-event billing telemetry into the steady-state log stream.

## [1.0.0-rc.2] - 2026-06-20
### Changed
- BREAKING: npm package renamed `openai-token-cost-reports` → `@herrhelms/openai-token-cost-reports` so installs match the user's npm scope. The in-app plugin key (`id` in manifest) and DB namespace stay as `openai-token-cost-reports` / `plugin_openai_token_cost_reports_5d9ad52d0e` — only the npm name changed.
- BREAKING: dashboard `routePath` renamed `oai-tokens` → `monthly-report-openai`. Dashboard URL becomes `/$COMPANY/monthly-report-openai`. The Claude-era `/$COMPANY/tokens` and previous `/$COMPANY/oai-tokens` no longer resolve.

## [1.0.0-rc.1] - 2026-06-19
### Added
- Initial release. Forked from `claude-token-cost-reports` v1.0.0-rc.3 (`github.com/herrhelms/paperclip-claude-token-cost-reports`).
- Dashboard at `/$COMPANY/oai-tokens` with 5 KPI cards, per-model bars, per-agent table, daily volume chart.
- Settings page with per-model rates, margin %, billing currency, FX-rate status.
- Monthly CSV export at `/api/plugins/openai-token-cost-reports/api/export/monthly.csv`.
- `backfillFromCostEvents` and `backfillAllHistory` actions that read `public.cost_events` with `provider = 'openai'` filter.
- Three idempotent migrations under the private DB namespace `plugin_openai_token_cost_reports_5d9ad52d0e`.

### Changed (vs. the Claude fork point)
- BREAKING: filters `cost_event.created` events to `provider === 'openai'`. Claude events are ignored.
- Pricing model rows replaced with OpenAI defaults from `developers.openai.com/api/docs/pricing` (fetched 2026-06-19): GPT-5.5, GPT-5.5 Pro, GPT-5.4, GPT-5.4 Mini, GPT-5.4 Nano, GPT-5.3 Codex.
- Subscription divisor concept removed. Cost = `tokens × rate × (1 + margin) × FX`. Settings dropdown removed; KPI row reverts to 5 cards (List + Net dropped); per-agent column headers always Cost/Price.
- `normalizeModel` recognizes the GPT-5.X family + GPT-5.3 Codex; returns `unknown` for Claude/Gemini/other-provider strings.
- README rewritten for OpenAI context with current install command.

### Migrated
- DB namespace `plugin_openai_token_cost_reports_5d9ad52d0e` (sha256 of slug).
- Tests rewritten: new manifest assertions, new `normalizeModel` cases, subscription-related tests removed. Final test count: 28.

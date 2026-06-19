# Changelog

All notable changes to this plugin will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

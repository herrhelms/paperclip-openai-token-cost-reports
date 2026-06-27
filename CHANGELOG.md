# Changelog

All notable changes to this plugin will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.1] - 2026-06-27

### Fixed
- **Dashboard no longer crashes ("OpenAI Token Usage: failed to render") on companies with seeded default pricing.** The pricing footer hardcoded the model key `"gpt-5-5"` (hyphen) but the default seed pricing uses `"gpt-5.5"` (period), so `pricingConfig.pricing["gpt-5-5"]` returned `undefined` and accessing `.input` on it threw. Replaced with a generic rate-count display (`"Pricing configured: N model rates; margin M%"`) that doesn't depend on any particular model key existing. Pre-existing bug from 2.0.0, surfaced on first real installs.

## [2.1.0] - 2026-06-27

Mirror of `@herrhelms/claude-token-cost-reports@2.1.1`. The dashboard's three money cards (List / Your cost / Client price) now compute from explicit per-tier values everywhere instead of inferring two of the three by back-arithmetic. setPricing also became "set my current pricing for every event" rather than "append a snapshot from now onward", matching every operator's actual mental model.

### Changed (semantics, not breaking the wire shape)
- **`setPricing` now replaces all snapshots with one epoch-effective row** instead of appending. Multiplier/margin/rate changes apply to every event in the company immediately — past and future. Implementation: INSERT-first-then-DELETE-non-epoch as two `ctx.db.execute` calls; the host's plugin-database validator only accepts bare INSERT/UPDATE/DELETE so a single CTE-atomic statement isn't possible. INSERT-first ordering means the company is never observed snapshot-less.
- **`effective_input_rate_multiplier` now scales the entire list price** (input + output), not just input. The variable name is a legacy 1.x artifact; the helper text already promised whole-bundle semantics.

### Added
- **`priceTiers(rawModel, input, output, cfg) → { list, cost, price, hasRate }`** — the canonical money helper. Single source of truth for the `list × multiplier × (1 + margin)` math. Replaces hand-rolled rollups previously duplicated at 5 worker handler sites.
- **`clearAllPricing({ companyId })`** action + Settings UI "Clear all" button. Operator escape hatch with confirmation prompt.
- Three money tiers explicitly emitted by `getDailyUsage`, `getPerModelForRange`, `getPerAgentBreakdown`: `list_usd` / `cost_usd` / `price_usd` plus their `_native` (FX-converted) twins. Worker emits `null` (not `0`) for money fields when a model has no rate row in the active config, so the UI can render the "no rate set / add rate →" chip per model.
- 6 new tests for `priceTiers` covering hasRate detection, multiplier+margin compounding, defaults, NaN-defense, and the `list ≥ cost ≤ price` ordering invariant.

### Fixed
- **PerModelCard / PerAgentCard now show all three money tiers per row** (List → Your cost → Client price). Previously only two columns ("Cost" / "Price") that conflated list and post-multiplier.
- **KPI sub-labels derive effective multiplier and margin from totals**, not from the latest snapshot's config. When the period spans snapshots with different settings, the label reads e.g. "+4.8% margin (mixed)" instead of falsely claiming "+0% margin" while Client price is materially above Your cost.
- **"No rate set" chip per model is reachable.** Worker was emitting `cost_usd = 0` (not `null`) for models with no rate row, masking the missing-rate case. Now emits `null` end-to-end.
- **HistoryPanel `parseTimestamp` helper handles cross-browser postgres timestamptz formats.** Normalizes space→T, bare `+HH`→`+HH:00`, appends `Z` for naive timestamps. Falls back to rendering the raw string if parsing still fails.
- **HistoryPanel Clear-all button persists after a wipe** — destructive action's only safety net no longer vanishes with the list it just emptied.
- **Epoch-effective snapshots render "Applies to every event"** instead of "1/1/1970, 1:00 AM". Save time still surfaces via `created_at`.

### Removed
- `getMonthlySummary` data handler. Had no UI consumer and its rollup became internally inconsistent when mult ≠ 1.
- `revertToPricingSnapshot` action. With wipe-and-replace `setPricing`, there's typically only one snapshot to revert from.
- `billable_usd` back-compat alias on DailyRow / PerModelRow. No consumer remained.

## [2.0.0] - 2026-06-22

First major version. Mirror of `@herrhelms/claude-token-cost-reports@2.0.5` with all UI / save-error / multiplier-input / loading-state patches baked in from day one. Replaces the hardcoded `ModelKey` enum + single mutable pricing config with a free-form pricing matrix stored as snapshots, so operators can add any model id themselves and historical periods bill against the rates active when the tokens were burned. No code release needed when OpenAI ships a new model id.

### Changed (breaking)
- BREAKING: `PricingConfig.pricing` type changes from `Record<ModelKey, …>` (fixed 12-entry enum) to `Record<string, RateRow>` (free-form keys).
- BREAKING: `ModelKey` type literal is removed. `usage_events.model` is now the raw payload string verbatim. Pricing lookup is exact match.
- BREAKING: `normalizeModel`, `PRICED_MODEL_KEYS`, `MODEL_LABELS`, `CSV_MODEL_LABELS`, `LEGACY_MODEL_REMAP` removed.

### Added
- `pricing_config_history` table (migration 004). Every save appends a row keyed by `(company_id, effective_from)`. Cost computation looks up the snapshot active at each event's `occurred_at`.
- Settings page: Add / Edit / Delete rows, optional `display_name` per row, **"Import OpenAI defaults"** button to seed the table, History panel with Revert-to-snapshot, deep-link from dashboard "no rate set" chip via URL hash.
- Loading / Empty states on the rate table so an in-flight `getPricing` never looks like an empty save.
- Verbose save errors: `validatePricingConfig` returns field-level messages (`"Invalid pricing config: row 'gpt-5.5': output must be >= 0 (got -5)"`); the UI extracts SDK error shapes via `extractErrorMessage` (no more `[object Object]` toasts). Inline red banner persists under the Save button until the next success.
- Multiplier input editable freely: uses `defaultValue` + `onBlur` so partial entries like `0`, `0.`, `0.0` don't snap back to `1` between keystrokes. Values outside `(0, 1]` revert visibly on blur.
- Dashboard: "no rate set" amber chip on per-model bars and per-agent table cells, with click-to-add-rate jump.
- CSV export `?unpriced=skip` (default) / `?unpriced=include` query param.
- Worker actions: `addPricingSnapshot` (explicit effective_from + note), `revertToPricingSnapshot`. `setPricing` retains its signature.
- Worker data handler: `listPricingHistory`.

### Migrated automatically (no operator action required)
- First 2.0.0 worker boot per host: walks each company with usage_events, migrates any 1.x `pricing-config` ctx.state to a `pricing_config_history` row with `effective_from = '1970-01-01T00:00:00Z'`. Then sweeps `model='unknown'` rows to use `raw_model` verbatim. Re-rolls affected days. Sets the instance-scoped marker so subsequent boots skip.

### Notable lessons baked in from the Claude rollout
- No destructive migration 005 (Paperclip Phase 1 blocks DROP TABLE). The dead `pricing_config` table from 001_init stays as harmless dead surface.

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

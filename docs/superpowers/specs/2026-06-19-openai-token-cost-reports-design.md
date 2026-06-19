# Design — openai-token-cost-reports

A Paperclip plugin that does for OpenAI API consumption what
[`claude-token-cost-reports`](https://github.com/herrhelms/paperclip-claude-token-cost-reports)
does for Claude consumption: track token usage per company, render a dashboard,
and export a client-facing monthly invoice CSV.

This plugin is a **standalone sibling** of the Claude plugin — separate repo,
separate npm package, separate database namespace, separate release cycle. Both
can be installed on the same Paperclip host without collision.

## Goals

1. Mirror the Claude plugin's dashboard, settings, and CSV export experience
   for OpenAI API usage.
2. Use OpenAI's pay-per-token economics directly — no subscription divisor, no
   "Pro / Max" preset. Cost = `tokens × rate × (1 + margin) × FX`.
3. Cover the GPT-5 family and o-series reasoning models out of the box; let
   the operator add more rows in Settings if their stack uses GPT-4.x.
4. Share zero code with the Claude plugin at install time; share architecture
   patterns only by virtue of being copy-and-edit.

## Non-goals

- Cached-input or Batch-API discount toggles. These get baked into the
  per-model rate the operator sets in Settings (e.g., a blended "effective
  GPT-5 rate"). Modelling them as explicit settings adds complexity that
  doesn't pay back for the typical Paperclip user.
- Embedding, audio, image, or fine-tuning costs. Out of scope; the plugin
  tracks LLM text-generation only.
- Aggregated cross-provider view. If both plugins are installed, each shows
  its own provider. A combined dashboard would be a third plugin.

## Approach

**Copy-and-edit** from `claude-token-cost-reports` v1.0.0-rc.3. The Claude
plugin's architecture is already validated end-to-end (10 commits of polish
post-baseline). Forking it is faster than running the paperclip-factory
`/new-plugin` workflow (which would generate fresh code that needs the same
polish pass) or starting greenfield.

## Identifiers

| Field | Value |
| --- | --- |
| npm package name | `openai-token-cost-reports` |
| Plugin id / slug | `openai-token-cost-reports` |
| Display name | OpenAI Token Usage |
| DB namespace | `plugin_openai_token_cost_reports_5d9ad52d0e` |
| Dashboard `routePath` | `oai-tokens` |
| Settings URL | `/$COMPANY/company/settings/instance/plugins/<install-uuid>` (host-managed) |
| CSV export route key | `export-monthly-csv` |
| CSV export path | `/export/monthly.csv` |
| API route prefix | `/api/plugins/openai-token-cost-reports/api/*` |
| GitHub repo | `github.com/herrhelms/paperclip-openai-token-cost-reports` |

Namespace hash computed from `sha256("openai-token-cost-reports")[0:10]`. If
the slug ever changes the hash must be recomputed in every migration file.

## Deltas vs. claude-token-cost-reports

| Surface | Claude plugin | OpenAI plugin |
| --- | --- | --- |
| Event filter | implicit Claude (all `cost_event.created` are processed) | `event.payload.provider === "openai"` at ingest; backfill `WHERE provider = 'openai'` |
| Pricing config schema | `subscription: { preset, divisor }` field | Field dropped; loader/upgrader ignores it for forward-compat |
| Settings dropdown | Subscription preset (Off / Pro ÷5 / Max ÷20) | Removed |
| KPI row | 6 cards (Total / Input / Output / List / Net / Price) | 5 cards (Total / Input / Output / Cost / Price) |
| KPI labels | Switch to "List" + "Sub-adjusted" when sub active | Always "Cost" + "Price" |
| Per-agent card | Drops "Sub-adjusted" column header switching logic | Unchanged from the no-subscription state |
| Billing math footnote | Conditional formula branch | Single formula: `Cost × (1 + margin%)` |
| ModelKey union | 8 Claude entries (Opus/Sonnet × 4.5/4.6/4.7/4.8 + [1m] variants) | 6 OpenAI entries: gpt-5.5, gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.3-codex |
| `normalizeModel` regex | `(opus\|sonnet)-X-Y(-1m)?` | `(gpt-5\\.5(-pro)?\|gpt-5\\.4(-mini\|-nano)?\|gpt-5\\.3-codex)` |
| Default rates (USD per MTok) | Live Claude prices | gpt-5.5 5/30 · gpt-5.5-pro 30/180 · gpt-5.4 2.50/15 · gpt-5.4-mini 0.75/4.50 · gpt-5.4-nano 0.20/1.25 · gpt-5.3-codex 1.75/14 — fetched 2026-06-19 from developers.openai.com/api/docs/pricing |
| Per-MTok default rates | From `platform.claude.com/docs/.../pricing` | From `platform.openai.com/docs/pricing` — fetched live at edit time |
| Display name + descriptions | Claude / Opus / Sonnet phrasing | OpenAI / GPT-5 / o-series phrasing |

**Same:** dashboard layout, monthly CSV export, FX job, backfill action,
data handlers (`getDailyUsage`, `getPerModelForRange`, `getPerAgentBreakdown`,
`getFxStatus`, `getIngestStats`), archive cleanup, theme integration, test
scope (with new model assertions; subscription tests dropped), esbuild config,
tsconfig setup.

## Architecture (recap)

Identical to the Claude plugin:

- **Worker:** subscribes to `cost_event.created` and `agent.run.finished`;
  filters on `provider === "openai"`; writes one row per event to
  `usage_events` keyed `cost_event:<id>`. Rolls up `usage_daily` every 15 min.
  Hourly job fetches USD→target FX rate from `open.er-api.com` for each active
  currency.
- **Dashboard** (`/$COMPANY/oai-tokens`): KPI row + per-model bar chart +
  per-agent expandable table + daily volume chart + ingest health + FX
  staleness chips.
- **Settings** (`/$COMPANY/company/settings/instance/plugins/<install-uuid>`):
  per-model rates, margin %, billing currency, "Refresh FX now". No
  subscription section.
- **Monthly CSV export** at
  `/api/plugins/openai-token-cost-reports/api/export/monthly.csv`. Same column
  set; price uses simple `Cost × (1 + margin)` since no divisor.

## Data model

Private namespace via `ctx.db`
(`plugin_openai_token_cost_reports_5d9ad52d0e`). Same three migrations:

- `001_init.sql` — `usage_events`, `usage_daily`, `pricing_config`.
- `002_costs_overview.sql` — adds `raw_model`, `provider`, `source`,
  `cached_input_tokens`, `cost_cents`, plus indexes. Idempotent.
- `003_fx_rates.sql` — `fx_rates(day, currency, rate, source, fetched_at)`.
  Idempotent.

`provider` column carries `"openai"` for every row; not strictly required
since the plugin only ingests OpenAI events, but kept for parity with the
Claude plugin's schema.

## Implementation flow (high level)

1. `cp -r claude-token-cost-reports/ openai-token-cost-reports/` (sibling).
2. Drop `.git` and dist artifacts; init a fresh git history.
3. Bulk text rename: `claude` → `openai`, `c7ca204bbe` → `5d9ad52d0e`,
   `Claude` → `OpenAI`, `Opus/Sonnet` → `GPT-5/o-series`, etc.
4. Manifest + UI: switch `routePath: "tokens"` → `"oai-tokens"`.
5. Pricing model swap (worker + UI): replace `ModelKey` union,
   `PRICED_MODEL_KEYS`, `DEFAULT_PRICING`, `MODEL_LABELS`, `normalizeModel`
   regex. Drop `SubscriptionPreset`, `SUBSCRIPTION_DIVISORS`,
   `SUBSCRIPTION_LABELS`, `subscription` field on `PricingConfig`.
6. Event filter: worker `ingestEvent` adds
   `if (provider !== "openai") return;`. Backfill action adds
   `AND provider = 'openai'` to the SELECT.
7. UI stripping: remove Subscription dropdown from Settings; drop List and Net
   KPI cards (5 cards total); always-Cost/Price labels; simpler footnote.
8. Tests: swap manifest assertions, replace `normalizeModel` cases, drop
   subscription tests.
9. Run `pnpm install && pnpm typecheck && pnpm test && pnpm build`.
10. Live verify: `paperclipai plugin install -l .`, then `bridge:data` smoke
    test on a real OpenAI-tagged event. Confirm `provider` field shape.
11. Tag `v1.0.0-rc.1`, push to `github.com/herrhelms/paperclip-openai-token-cost-reports`.

The detailed step-by-step (with exact commands, file diffs, and verification
gates) belongs in the implementation plan, not this design doc.

## Risks and mitigations

- **OpenAI events may not be tagged `provider: "openai"`.** The Paperclip host
  may use `"OpenAI"`, `"oai"`, or an entirely different key. Mitigation:
  during the live smoke test (step 10), run `paperclipai cost by-agent-model`
  for a known OpenAI-using company and inspect the actual `provider` string.
  Adjust the filter constant accordingly before tagging the RC.
- **GPT-5 family pricing may change between design and implementation.**
  Mitigation: fetch from `platform.openai.com/docs/pricing` at the moment of
  rendering the `DEFAULT_PRICING` object and record the fetch timestamp in
  the CHANGELOG. Operators can override in Settings.
- **`routePath: "oai-tokens"` could collide with a future Paperclip host
  route.** Mitigation: grep the live host UI bundle the same way we discovered
  `/tokens` was free for the Claude plugin. If `oai-tokens` is taken, fall
  back to `openai-tokens`.
- **Operator may have both plugins installed and confuse them.** Mitigation:
  display name is "OpenAI Token Usage" (vs. Claude's "Claude Token Usage");
  sidebar entries are distinct; dashboard URLs differ
  (`/$COMPANY/tokens` vs. `/$COMPANY/oai-tokens`); the README's "Naming"
  section spells out the URL scheme.

## Testing

Inherits the Claude plugin's pure-function test suite, adjusted:

- `manifest` block — assert new id, slug, routePath, capabilities.
- `normalizeModel` block — assert recognition for `gpt-5`, `gpt-5-mini`,
  `gpt-5-nano`, `o3`, `o3-mini`, `o4-mini` (including versioned snapshots like
  `gpt-5-2025-XX-XX`); assert `"unknown"` for `opus-4-7`, `sonnet-4-6`, and
  other Claude-family strings.
- `priceFor` block — same shape, new model keys.
- `subscriptionDivisor`, `SUBSCRIPTION_DIVISORS`, `isPricingConfig`
  subscription branches — **removed.**
- `upgradePricingConfig` — keep one test asserting that a legacy
  `subscription` field is silently ignored.

Target: 25–28 tests after the subscription drop.

## Open questions deferred to implementation

- ~~Exact GPT-5 / o-series rates (looked up at render time).~~ — Resolved
  2026-06-19: fetched from developers.openai.com/api/docs/pricing. Live model
  IDs are gpt-5.5/5.4 (not gpt-5/mini/nano); o3/o3-mini are no longer in the
  standard pricing table. Defaults locked into the spec table above.
- Whether `provider` filter value is `"openai"` (verified at smoke test).
- Whether `oai-tokens` routePath is free on the live host (verified at smoke
  test).

## Out of scope (this spec)

- Cached input + Batch discount handling.
- Embedding, audio, image, fine-tuning cost tracking.
- Aggregated cross-provider dashboard.
- Automatic OpenAI pricing refresh (operator manually updates rates in
  Settings when OpenAI publishes new prices).

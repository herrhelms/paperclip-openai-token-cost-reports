# Claude Token Cost Reports

> A Paperclip plugin that turns flat-rate Claude subscription consumption into a token-priced client invoice.

Track Claude token usage per Paperclip company, see who burned what across agents and models, and export a client-facing monthly invoice CSV in the currency you bill in. Daily FX snapshots, configurable margin, and a subscription divisor that reflects what the operator actually pays Anthropic.

Designed for operators on a **Claude Pro** or **Claude Max** subscription who want to bill clients in a real currency without losing visibility on what API list price would have been.

---

## Install

```bash
# From inside a Paperclip-enabled environment with the CLI installed:
paperclipai plugin install claude-token-cost-reports

# Verify the install
paperclipai plugin list
# expect: key=claude-token-cost-reports  status=ready  version=1.0.0-rc.2  id=<uuid>
```

The host runs the plugin's database migrations automatically and registers the dashboard + settings page slots. No additional configuration is required to install — pricing and currency are set per-company in the Settings page after install.

### Requirements

- Paperclip host with `@paperclipai/plugin-sdk` >= `2026.609.0` available.
- Node.js 22+ on the host that runs the plugin worker.
- Outbound HTTP access from the host to `https://open.er-api.com` (used by the hourly FX-rate job).
- The plugin must be granted the capabilities listed in [Capabilities](#capabilities). The Paperclip host prompts the operator on install.

### Where it shows up after install

| Surface | Where to find it | What's there |
| --- | --- | --- |
| Dashboard | `/$COMPANY_HANDLE/tokens` (in the company sidebar) | Usage KPIs, per-model bars, per-agent table, daily chart, monthly CSV export |
| Settings | `/$COMPANY_HANDLE/company/settings/instance/plugins/<install-uuid>` | Per-model pricing, margin, currency, subscription preset, FX-rate status |

The `<install-uuid>` is shown by `paperclipai plugin list` after install.

---

## Quick start

After install, open the Settings page for any company:

1. **Pick a billing currency** (10 supported). The hourly FX job will fetch today's USD→target rate and store one row per `(day, currency)`.
2. **Set a margin %** — the percentage you add on top of cost when invoicing the client.
3. **Choose a subscription preset:**
   - **Off** — client pays for raw API consumption (no divisor).
   - **Claude Pro (÷5)** — operator is on a Pro subscription; costs are divided by 5 before margin.
   - **Claude Max (÷20)** — operator is on a Max subscription; costs are divided by 20 before margin.
4. (Optional) **Adjust per-model rates.** Defaults are seeded from current Anthropic list prices for Opus 4.8 / 4.7 and Sonnet 4.6 / 4.5 (including 1M-context variants).
5. **Backfill historical events.** The Settings page has a `Backfill from history` button (for the current period) and `Backfill all history` (since the company's first cost event). The plugin reads directly from the host's `public.cost_events` table via the `coreReadTables` whitelist, so historical data from before the plugin install is available immediately.

Then open `/$COMPANY_HANDLE/tokens` — the dashboard reflects the configuration within a second.

---

## What it does

- Subscribes to `cost_event.created` and `agent.run.finished` and writes one row per event into a private `usage_events` table. Keys are `cost_event:<id>` for cost events so the live subscription and `Backfill from history` action share a keyspace and dedupe idempotently.
- Rolls up to `usage_daily` every 15 minutes per company.
- Fetches a daily USD→target FX rate from `open.er-api.com` and stores one row per `(day, currency)` in `fx_rates`. Only fetches for currencies at least one company has configured.
- Cleans up automatically when a company is archived (purges `usage_events`, `usage_daily`, `pricing_config`, currency state).

### Dashboard at `/$COMPANY/tokens`

- 6 KPI cards: total tokens, input, output, list (pre-margin), net (subscription-adjusted), price (chargeback). Labels switch to **List** + **Sub-adjusted** when a subscription preset is active.
- Per-model horizontal bar chart with native-currency cost and price.
- Per-agent table with totals + per-model breakdown (Runs / Input / Output / Cost / Price columns).
- Daily volume column chart — input + output stacked, peak label.
- Status chips for ingest health and FX staleness next to the title.

### Settings at `/$COMPANY/company/settings/instance/plugins/<install-uuid>`

- Per-model rates (USD per 1M input / output) for Opus 4.8 / 4.7, Sonnet 4.6 / 4.5, plus the 1M-context variants.
- Margin %.
- Billing currency (10 currencies), with **Refresh FX now** and a status line showing the active rate.
- Subscription preset (Off / Claude Pro ÷5 / Claude Max ÷20).

The dashboard inherits the host's Paperclip theme (light/dark, shadcn-style cards) by referencing host CSS variables directly.

---

## Subscription mode

The plugin computes two cost lanes per row:

- **List** = `tokens × per-MTok rate` — what API billing would charge.
- **Sub-adjusted** = `List ÷ divisor × (1 + margin)` — what the operator bills the client.

The divisor comes from the Subscription preset in Settings:

| Preset | Divisor | Use when |
| --- | --- | --- |
| Off | 1 | Client pays for raw API consumption |
| Claude Pro | 5 | Operator covers usage with a Pro subscription |
| Claude Max | 20 | Operator covers usage with a Max subscription |

Switching modes never rewrites historical data — it's a render-time recompute. The dashboard's KPI labels and the per-agent table column headers update in place. The monthly CSV applies the divisor at row aggregation time so the exported invoice matches the dashboard total to the cent.

---

## Billing math

For each event with model `m`, input tokens `i`, output tokens `o`:

```text
list_cost     = (i × pricing[m].input + o × pricing[m].output) / 1_000_000     # USD
operator_cost = list_cost / subscriptionDivisor                                 # Pro÷5, Max÷20, Off÷1
client_price  = operator_cost × (1 + margin.percent / 100)                      # USD
row.price     = client_price × fx_rate(month_end_day, currency)                 # Native currency
```

The dashboard KPI **Cost** shows `list_cost` summed in native currency (what an API user would pay at list price). KPI **Price** shows `row.price` summed (what the client owes after margin and currency conversion). The per-model and per-agent cards show both side by side, so reconciliation is explicit.

The monthly CSV emits only `row.price` — operator-internal numbers (list cost, divisor, margin %) stay off the file you send to the client.

---

## Monthly CSV export

```text
GET /api/plugins/claude-token-cost-reports/api/export/monthly.csv?companyId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
```

Columns: `period, month_start, month_end, model, input_tokens, output_tokens, total_tokens, currency, price`.

Multi-month exports include a `model = TOTAL` row at the end of each month section. Filename: `usage-<company-slug>-<from>-<to>-<currency>.csv`.

---

## Capabilities

The Paperclip host gates each of these on install. All are required for the plugin to function correctly.

| Capability | Why it's declared |
| --- | --- |
| `events.subscribe` | Receive `cost_event.created`, `agent.run.finished`, `company.updated` |
| `costs.read` | Gates delivery of `cost_event.created` |
| `agents.read` | Resolve agent display names for the per-agent breakdown |
| `companies.read` | Resolve company name for the CSV filename slug |
| `database.namespace.migrate` / `.read` / `.write` | Private SQL namespace |
| `plugin.state.read` / `.write` | Per-company pricing + currency config in `ctx.state` |
| `jobs.schedule` | `rollup-daily` (15 min) and `fetch-fx-daily` (hourly) |
| `api.routes.register` | Scoped CSV export route |
| `ui.page.register` | Dashboard page slot |
| `instance.settings.register` | Settings page slot |
| `http.outbound` | Daily FX fetch from `open.er-api.com` |

---

## Reference

### Data model

Private SQL namespace via `ctx.db` (`plugin_claude_token_cost_reports_c7ca204bbe`):

- `usage_events(source_event_id PRIMARY KEY, company_id, agent_id, model, raw_model, provider, source, input_tokens, output_tokens, cached_input_tokens, cost_cents, occurred_at, day TEXT)` — append-only event log. `raw_model` preserves the literal model id (`claude-opus-4-7[1m]`) while `model` holds the normalized key; `provider` and `source` (`api` / `subscription`) drive the cost split.
- `usage_daily(company_id, day TEXT, model, input_tokens, output_tokens, PRIMARY KEY(company_id, day, model))` — rolled-up daily totals.
- `pricing_config(company_id PRIMARY KEY, json TEXT)` — kept for historical compatibility; live pricing lives in `ctx.state`.
- `fx_rates(day, currency, rate, source, fetched_at, PRIMARY KEY(day, currency))` — daily USD-base FX snapshots.

Migrations: `migrations/001_init.sql`, `migrations/002_costs_overview.sql`, `migrations/003_fx_rates.sql`.

Core-read tables (declared in manifest): `cost_events` — used by the backfill action to import history from before the plugin install.

### Plugin state keys

- Company-scoped: `pricing-config` (rates + margin + subscription), `currency-config` (selected billing currency).
- Instance-scoped: `active-currencies` (string[] — drives which currencies the daily fetcher requests).

### Data handlers (registered on `ctx.data`, called from UI via `usePluginData`)

- `getDailyUsage({ companyId, from, to })` — daily rows with cost/price in USD and native currency. Drives the dashboard daily chart + KPIs.
- `getMonthlySummary({ companyId, from, to })` — calendar-month rollups (legacy aggregate, kept for the API surface).
- `getPerModelForRange({ companyId, from, to })` — per-model breakdown with cost → price in native currency.
- `getPerAgentBreakdown({ companyId, from, to })` — per-agent + per-model with runs, tokens, cost, price.
- `getPricing({ companyId })` — bare PricingConfig.
- `getCurrencyConfig({ companyId })` — `{ currency, supported }`.
- `getFxStatus({ companyId })` — current rate, day, source for the company's currency.
- `getIngestStats({ companyId })` — total + 24h ingest counts for the dashboard health chip.

### Actions (registered on `ctx.actions`, called from UI via `usePluginAction`)

- `setPricing({ companyId, config })`
- `setCurrencyConfig({ companyId, currency })` (best-effort prefetches FX)
- `refreshFxNow({ companyId })`
- `backfillFromCostEvents({ companyId, from, to })`
- `backfillAllHistory({ companyId })`

### API routes

Mounted under `/api/plugins/claude-token-cost-reports/api/*`:

- `GET /export/monthly.csv?companyId=...&from=...&to=...` — streams the client-facing monthly CSV. `auth: board`.

---

## Naming and forking

Three names refer to the same thing; keep them aligned across npm, the host, and the database:

| Surface | Value | Where it's set |
| --- | --- | --- |
| npm package name | `claude-token-cost-reports` | `package.json` `name` |
| In-app plugin key | `claude-token-cost-reports` | `src/manifest.ts` `id` |
| Private DB namespace | `plugin_claude_token_cost_reports_c7ca204bbe` | derived by the host as `plugin_<slug-with-underscores>_<sha256(slug)[0:10]>` |

The `c7ca204bbe` suffix is the first 10 hex characters of `sha256("claude-token-cost-reports")`. **Forks that rename the plugin must regenerate this suffix in every migration file** — the host computes the namespace from the slug at install time, and a stale suffix in the SQL makes every migration fail with "schema X does not exist". A one-liner to recompute:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('your-new-slug').digest('hex').slice(0,10))"
```

Then `sed -i '' 's/plugin_claude_token_cost_reports_c7ca204bbe/plugin_<new_slug>_<new_hash>/g' migrations/*.sql`. Tests do not catch this — the SQL runs at host install time, not at plugin build time.

---

## Build from source

For developers and forks. Standalone plugin package; built against `@paperclipai/plugin-sdk`. TypeScript throughout; React + inline CSS for the UI (no Tailwind); esbuild for both the worker and the UI bundle.

```bash
pnpm install
pnpm typecheck       # base + tests/ (chained via tsconfig.test.json)
pnpm test            # 33 unit tests on the pure math + manifest
pnpm build           # emits dist/manifest.js, dist/worker.js, dist/ui/index.js

# Install the locally built copy into the Paperclip host on this machine:
paperclipai plugin install -l .
paperclipai plugin list
```

For a clean reinstall during development:

```bash
paperclipai plugin uninstall claude-token-cost-reports --force
paperclipai plugin install -l .
```

See [`docs/PRODUCTION-INSTALL-CHECKLIST.md`](docs/PRODUCTION-INSTALL-CHECKLIST.md) for a verification flow to run after the first install on a non-dev Paperclip host.

---

## License

MIT — see [`LICENSE`](LICENSE).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

# OpenAI Token Cost Reports

> A Paperclip plugin that turns raw OpenAI API consumption into a token-priced client invoice.

Track OpenAI API token usage per Paperclip company, see who burned what across agents and models, and export a client-facing monthly invoice CSV in the currency you bill in. Daily FX snapshots and configurable margin.

Designed for operators on the OpenAI API who want to bill clients in a real currency without losing visibility on what API list price would have been.

---

## Install

```bash
# From inside a Paperclip-enabled environment with the CLI installed:
paperclipai plugin install @herrhelms/openai-token-cost-reports

# Verify the install
paperclipai plugin list
# expect: key=openai-token-cost-reports  status=ready  version=1.0.1  id=<uuid>
```

The host runs the plugin's database migrations automatically and registers the dashboard + settings page slots. No additional configuration is required to install — pricing and currency are set per-company in the Settings page after install.

> The npm package is scoped (`@herrhelms/…`) but the in-app plugin key is not — that's a Paperclip-host convention. To uninstall, use the unscoped key:
>
> ```bash
> paperclipai plugin uninstall openai-token-cost-reports
> ```
>
> `paperclipai plugin list` prints the unscoped key next to each install, so you can always discover it from the host.

### Requirements

- Paperclip host with `@paperclipai/plugin-sdk` >= `2026.609.0` available.
- Node.js 22+ on the host that runs the plugin worker.
- Outbound HTTP access from the host to `https://open.er-api.com` (used by the hourly FX-rate job).
- The plugin must be granted the capabilities listed in [Capabilities](#capabilities). The Paperclip host prompts the operator on install.

### Where it shows up after install

| Surface | Where to find it | What's there |
| --- | --- | --- |
| Dashboard | `/$COMPANY_HANDLE/monthly-report-openai` (in the company sidebar) | Usage KPIs, per-model bars, per-agent table, daily chart, monthly CSV export |
| Settings | `/$COMPANY_HANDLE/company/settings/instance/plugins/<install-uuid>` | Per-model pricing, margin, currency, FX-rate status |

The `<install-uuid>` is shown by `paperclipai plugin list` after install.

---

## Quick start

After install, open the Settings page for any company:

1. **Pick a billing currency** (10 supported). The hourly FX job will fetch today's USD→target rate and store one row per `(day, currency)`.
2. **Set a margin %** — the percentage you add on top of cost when invoicing the client.
3. (Optional) **Adjust per-model rates.** Defaults are seeded from current OpenAI list prices for GPT-5.5, GPT-5.4, and GPT-5.3-codex families.
4. **Backfill historical events.** The Settings page has a `Backfill from history` button (for the current period) and `Backfill all history` (since the company's first cost event). The plugin reads directly from the host's `public.cost_events` table via the `coreReadTables` whitelist, so historical data from before the plugin install is available immediately.

Then open `/$COMPANY_HANDLE/monthly-report-openai` — the dashboard reflects the configuration within a second.

---

## What it does

- Subscribes to `cost_event.created` and `agent.run.finished` and writes one row per event into a private `usage_events` table. Keys are `cost_event:<id>` for cost events so the live subscription and `Backfill from history` action share a keyspace and dedupe idempotently.
- Rolls up to `usage_daily` every 15 minutes per company.
- Fetches a daily USD→target FX rate from `open.er-api.com` and stores one row per `(day, currency)` in `fx_rates`. Only fetches for currencies at least one company has configured.
- Cleans up automatically when a company is archived (purges `usage_events`, `usage_daily`, `pricing_config`, currency state).

### Dashboard at `/$COMPANY/monthly-report-openai`

- 5 KPI cards: total tokens, input, output, cost (pre-margin), price (chargeback).
- Per-model horizontal bar chart with native-currency cost and price.
- Per-agent table with totals + per-model breakdown (Runs / Input / Output / Cost / Price columns).
- Daily volume column chart — input + output stacked, peak label.
- Status chips for ingest health and FX staleness next to the title.

### Settings at `/$COMPANY/company/settings/instance/plugins/<install-uuid>`

- Per-model rates (USD per 1M input / output) for the GPT-5.5 / GPT-5.4 / GPT-5.3-codex families.
- Margin %.
- Billing currency (10 currencies), with **Refresh FX now** and a status line showing the active rate.

The dashboard inherits the host's Paperclip theme (light/dark, shadcn-style cards) by referencing host CSS variables directly.

---

## Billing math

For each event with model `m`, input tokens `i`, output tokens `o`:

```text
cost_usd     = (i × pricing[m].input + o × pricing[m].output) / 1_000_000     # USD
client_price = cost_usd × (1 + margin.percent / 100)                            # USD
row.price    = client_price × fx_rate(month_end_day, currency)                  # Native currency
```

The dashboard KPI **Cost** shows `cost_usd` summed in native currency (what an API user would pay at list price). KPI **Price** shows `row.price` summed (what the client owes after margin and currency conversion). The per-model and per-agent cards show both side by side, so reconciliation is explicit.

The monthly CSV emits only `row.price` — operator-internal numbers (margin %) stay off the file you send to the client.

---

## Monthly CSV export

```text
GET /api/plugins/openai-token-cost-reports/api/export/monthly.csv?companyId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
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

Private SQL namespace via `ctx.db` (`plugin_openai_token_cost_reports_5d9ad52d0e`):

- `usage_events(source_event_id PRIMARY KEY, company_id, agent_id, model, raw_model, provider, source, input_tokens, output_tokens, cached_input_tokens, cost_cents, occurred_at, day TEXT)` — append-only event log. `raw_model` preserves the literal model id while `model` holds the normalized key; `provider` and `source` (`api` / `subscription`) drive the cost split.
- `usage_daily(company_id, day TEXT, model, input_tokens, output_tokens, PRIMARY KEY(company_id, day, model))` — rolled-up daily totals.
- `pricing_config(company_id PRIMARY KEY, json TEXT)` — kept for historical compatibility; live pricing lives in `ctx.state`.
- `fx_rates(day, currency, rate, source, fetched_at, PRIMARY KEY(day, currency))` — daily USD-base FX snapshots.

Migrations: `migrations/001_init.sql`, `migrations/002_costs_overview.sql`, `migrations/003_fx_rates.sql`.

Core-read tables (declared in manifest): `cost_events` — used by the backfill action to import history from before the plugin install. Filtered by `provider = 'openai'`.

### Plugin state keys

- Company-scoped: `pricing-config` (rates + margin), `currency-config` (selected billing currency).
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

Mounted under `/api/plugins/openai-token-cost-reports/api/*`:

- `GET /export/monthly.csv?companyId=...&from=...&to=...` — streams the client-facing monthly CSV. `auth: board`.

---

## Naming and forking

Three names refer to the same thing; keep them aligned across npm, the host, and the database:

| Surface | Value | Where it's set |
| --- | --- | --- |
| npm package name | `@herrhelms/openai-token-cost-reports` | `package.json` `name` |
| In-app plugin key | `openai-token-cost-reports` | `src/manifest.ts` `id` |
| Private DB namespace | `plugin_openai_token_cost_reports_5d9ad52d0e` | derived by the host as `plugin_<slug-with-underscores>_<sha256(slug)[0:10]>` |

The `5d9ad52d0e` suffix is the first 10 hex characters of `sha256("openai-token-cost-reports")`. **Forks that rename the plugin must regenerate this suffix in every migration file** — the host computes the namespace from the slug at install time, and a stale suffix in the SQL makes every migration fail with "schema X does not exist". A one-liner to recompute:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('openai-token-cost-reports').digest('hex').slice(0,10))"
```

Then `sed -i '' 's/plugin_openai_token_cost_reports_5d9ad52d0e/plugin_<new_slug>_<new_hash>/g' migrations/*.sql`. Tests do not catch this — the SQL runs at host install time, not at plugin build time.

---

## Build from source

For developers and forks. Standalone plugin package; built against `@paperclipai/plugin-sdk`. TypeScript throughout; React + inline CSS for the UI (no Tailwind); esbuild for both the worker and the UI bundle.

```bash
pnpm install
pnpm typecheck       # base + tests/ (chained via tsconfig.test.json)
pnpm test            # 28 unit tests on the pure math + manifest
pnpm build           # emits dist/manifest.js, dist/worker.js, dist/ui/index.js

# Install the locally built copy into the Paperclip host on this machine:
paperclipai plugin install -l .
paperclipai plugin list
```

For a clean reinstall during development:

```bash
paperclipai plugin uninstall openai-token-cost-reports --force
paperclipai plugin install -l .
```

See [`docs/PRODUCTION-INSTALL-CHECKLIST.md`](docs/PRODUCTION-INSTALL-CHECKLIST.md) for a verification flow to run after the first install on a non-dev Paperclip host.

---

## License

MIT — see [`LICENSE`](LICENSE).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

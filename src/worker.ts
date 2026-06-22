import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
} from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginEvent,
} from "@paperclipai/plugin-sdk";
import type { PricingConfig, PricingSnapshot } from "./pricing";
import {
  validatePricingConfig,
  findActiveSnapshot,
  lookupRate,
  DEFAULT_SEED_PRICING,
} from "./pricing";

// 2.0.0: usage_events.model and usage_daily.model are now free-form strings —
// whatever the host emitted, preserved verbatim. The ModelKey union, the
// PRICED_MODEL_KEYS list, normalizeModel, LEGACY_MODEL_REMAP, the worker-local
// DEFAULT_PRICING + isPricingConfig + upgradePricingConfig, and the
// CSV_MODEL_LABELS lookup are all gone. Pricing lookup is an exact match against
// the operator's free-form rate table (see lookupRate in ./pricing).

interface DailyRow {
  company_id: string;
  day: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

function toDay(iso: string): string {
  return iso.slice(0, 10);
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthEnd(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
}

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
  // YYYY-MM — used as the bucket key so all rollups land on the same calendar month.
  return d.toISOString().slice(0, 7);
}

function q(ctx: PluginContext, table: string): string {
  return `${ctx.db.namespace}.${table}`;
}

// Strict ISO-date guard for query params that flow into SQL bindings and
// HTTP response headers. Accepts the YYYY-MM-DD shape only — rejects
// embedded quotes/CRLFs that would break the Content-Disposition filename
// or smuggle a response header.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && ISO_DATE_RE.test(s);
}

// RFC 4180 cell escape. Wraps a value in double quotes and doubles any
// internal quote IF the value contains a comma, quote, CR, or LF;
// otherwise returns the value unchanged. Safe for the CSV's current cells
// (numbers, allow-listed currency codes, static labels) AND defensive
// against future cells that surface raw_model or other user-derived text.
export function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function pricingScope(companyId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    stateKey: "pricing-config",
  };
}

function migrationScope() {
  return {
    scopeKind: "instance" as const,
    scopeId: "_global",
    stateKey: "migration_2_0_0_done",
  };
}

// Snapshot storage helpers. The 1.x single-doc ctx.state config is gone;
// authoritative pricing lives in pricing_config_history (one row per save).
// Reads are DESC by effective_from so findActiveSnapshot's linear scan is
// O(1) in the common N=1 case.
async function loadAllSnapshots(
  ctx: PluginContext,
  companyId: string,
): Promise<PricingSnapshot[]> {
  const rows = await ctx.db.query<{
    effective_from: string;
    config_json: PricingConfig;
    created_at: string;
    created_by: string | null;
    note: string | null;
  }>(
    `SELECT effective_from::text AS effective_from,
            config_json,
            created_at::text AS created_at,
            created_by,
            note
       FROM ${q(ctx, "pricing_config_history")}
      WHERE company_id = $1
      ORDER BY effective_from DESC`,
    [companyId],
  );
  return rows.map((r) => ({
    effective_from: r.effective_from,
    config: r.config_json,
    created_at: r.created_at,
    created_by: r.created_by,
    note: r.note,
  }));
}

async function insertSnapshot(
  ctx: PluginContext,
  companyId: string,
  effectiveFrom: string,
  config: PricingConfig,
  note: string | null,
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${q(ctx, "pricing_config_history")}
       (company_id, effective_from, config_json, note)
     VALUES ($1, $2::timestamptz, $3::jsonb, $4)
     ON CONFLICT (company_id, effective_from) DO UPDATE
       SET config_json = EXCLUDED.config_json,
           note = EXCLUDED.note`,
    [companyId, effectiveFrom, JSON.stringify(config), note],
  );
}

async function runMigration2_0_0(ctx: PluginContext): Promise<void> {
  const marker = await ctx.state.get(migrationScope());
  if (marker === true) return;

  ctx.logger.info("migration 2.0.0 starting");

  const companies = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM ${q(ctx, "usage_events")}`,
  );
  let migratedConfigs = 0;
  for (const { company_id } of companies) {
    const existing = await ctx.state.get(pricingScope(company_id));
    if (existing && typeof existing === "object") {
      const e = existing as Record<string, unknown>;
      const legacyPricing = (e.pricing ?? {}) as Record<string, { input: number; output: number }>;
      const legacyMargin = ((e.margin as { percent?: number } | undefined)?.percent) ?? 0;
      const config = {
        pricing: legacyPricing,
        margin: { percent: legacyMargin },
        effective_input_rate_multiplier: 1,
      };
      if (validatePricingConfig(config) === null) {
        await insertSnapshot(
          ctx,
          company_id,
          "1970-01-01T00:00:00Z",
          config,
          "auto-migrated from 1.x ctx.state",
        );
        migratedConfigs++;
      }
    }
  }

  ctx.logger.info("migration 2.0.0 ctx.state -> history done", { migratedConfigs });

  // Cleanup sweep: any usage_events row with model='unknown' and a
  // non-'unknown' raw_model gets model = raw_model. 2.0.0 doesn't
  // normalize — pricing match is exact against the operator's table.
  let resweptRows = 0;
  const sweepRows = await ctx.db.query<{
    source_event_id: string;
    company_id: string;
    day: string;
    raw_model: string | null;
  }>(
    `SELECT source_event_id, company_id, day, raw_model
       FROM ${q(ctx, "usage_events")}
      WHERE model = 'unknown' AND raw_model IS NOT NULL`,
  );
  const affectedDays = new Set<string>();
  for (const r of sweepRows) {
    if (!r.raw_model) continue;
    if (r.raw_model !== "unknown") {
      await ctx.db.execute(
        `UPDATE ${q(ctx, "usage_events")} SET model = $1 WHERE source_event_id = $2`,
        [r.raw_model, r.source_event_id],
      );
      resweptRows++;
      affectedDays.add(`${r.company_id}|${r.day}`);
    }
  }
  for (const key of affectedDays) {
    const [companyId, day] = key.split("|");
    await rollupCompanyDay(ctx, companyId, day);
  }
  ctx.logger.info("migration 2.0.0 sweep done", { resweptRows, daysRolledUp: affectedDays.size });

  await ctx.state.set(migrationScope(), true);
  ctx.logger.info("migration 2.0.0 complete");
}

export async function loadActiveConfig(
  ctx: PluginContext,
  companyId: string,
  occurredAt: string,
): Promise<PricingConfig | null> {
  const snapshots = await loadAllSnapshots(ctx, companyId);
  const snap = findActiveSnapshot(snapshots, occurredAt);
  return snap?.config ?? null;
}

export { lookupRate, findActiveSnapshot } from "./pricing";

// Resolves a single active snapshot at `occurredAt`. Callers wanting the
// "current" config pass `new Date().toISOString()`. All five cost-
// computation handlers below use loadAllSnapshots + findActiveSnapshot
// directly instead, so they can reuse the snapshot list per-row without
// re-querying. Exposed for tests and external callers.
export async function loadPricing(
  ctx: PluginContext,
  companyId: string,
  occurredAt: string,
): Promise<PricingConfig | null> {
  return loadActiveConfig(ctx, companyId, occurredAt);
}

// ---- Currency + FX -------------------------------------------------------
//
// All token pricing happens in USD (per-1M rates seeded from Anthropic's list
// prices). The operator picks a *billing* currency per-company; the dashboard
// converts USD -> billing currency at the per-day FX rate that was recorded
// when the agents actually ran. Margin is added LAST so the displayed Price
// is what the client is invoiced.
//
// Storage layout:
//   ctx.state company-scoped key "currency-config" -> { currency: "USD" | ... }
//   ctx.state instance-scoped key "active-currencies" -> string[] (union)
//   plugin namespace fx_rates(day, currency, rate, source, fetched_at)
//
// The instance-scoped active-currencies set drives the daily fetch job: it
// only fetches rates for currencies that at least one company is actually
// using, so empty-config companies don't trigger network calls.

const SUPPORTED_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "CAD",
  "AUD",
  "JPY",
  "DKK",
  "SEK",
  "NOK",
] as const;
type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

interface CurrencyConfig {
  currency: CurrencyCode;
}

const DEFAULT_CURRENCY: CurrencyConfig = { currency: "USD" };

// open.er-api.com: free, no API key, daily-updated USD-base rates.
const FX_PROVIDER_NAME = "open.er-api.com";
const FX_PROVIDER_URL = "https://open.er-api.com/v6/latest/USD";

function isCurrencyCode(v: unknown): v is CurrencyCode {
  return (
    typeof v === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(v)
  );
}

function currencyScope(companyId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    stateKey: "currency-config",
  };
}

const ACTIVE_CURRENCIES_SCOPE = {
  scopeKind: "instance" as const,
  stateKey: "active-currencies",
};

async function loadCurrency(
  ctx: PluginContext,
  companyId: string,
): Promise<CurrencyConfig> {
  const raw = await ctx.state.get(currencyScope(companyId));
  if (raw && typeof raw === "object") {
    const c = (raw as { currency?: unknown }).currency;
    if (isCurrencyCode(c)) return { currency: c };
  }
  return DEFAULT_CURRENCY;
}

async function loadActiveCurrencies(ctx: PluginContext): Promise<Set<CurrencyCode>> {
  const raw = await ctx.state.get(ACTIVE_CURRENCIES_SCOPE);
  const out = new Set<CurrencyCode>();
  if (Array.isArray(raw)) {
    for (const v of raw) if (isCurrencyCode(v)) out.add(v);
  }
  return out;
}

async function noteActiveCurrency(
  ctx: PluginContext,
  currency: CurrencyCode,
): Promise<void> {
  const set = await loadActiveCurrencies(ctx);
  if (set.has(currency)) return;
  set.add(currency);
  await ctx.state.set(ACTIVE_CURRENCIES_SCOPE, Array.from(set));
}

async function upsertFxRate(
  ctx: PluginContext,
  day: string,
  currency: CurrencyCode,
  rate: number,
  source: string,
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${q(ctx, "fx_rates")} (day, currency, rate, source, fetched_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (day, currency) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
    [day, currency, rate, source],
  );
}

// Look up a stored rate. Prefers an exact day match; falls back to the most
// recent rate stored before `day` so dashboards aren't blank when today's
// fetch hasn't landed yet (or a historical row is missing).
async function getFxRate(
  ctx: PluginContext,
  day: string,
  currency: CurrencyCode,
): Promise<{ rate: number; day: string; source: string } | null> {
  if (currency === "USD") {
    return { rate: 1, day, source: "identity" };
  }
  const exact = await ctx.db.query<{ rate: string; source: string }>(
    `SELECT rate::text AS rate, source
       FROM ${q(ctx, "fx_rates")}
      WHERE day = $1 AND currency = $2
      LIMIT 1`,
    [day, currency],
  );
  if (exact.length > 0) {
    return { rate: Number(exact[0].rate), day, source: exact[0].source };
  }
  const recent = await ctx.db.query<{ day: string; rate: string; source: string }>(
    `SELECT day, rate::text AS rate, source
       FROM ${q(ctx, "fx_rates")}
      WHERE currency = $1 AND day <= $2
      ORDER BY day DESC
      LIMIT 1`,
    [currency, day],
  );
  if (recent.length > 0) {
    return {
      rate: Number(recent[0].rate),
      day: recent[0].day,
      source: recent[0].source,
    };
  }
  return null;
}

// Sanity envelope for an USD-base FX rate. The 10 supported currencies
// span roughly 0.5 (GBP) to 160 (JPY) historically; 0.01 .. 1000 catches
// catastrophic upstream errors (e.g., a hijacked provider serving
// inflated rates) while staying loose enough to absorb normal volatility.
const FX_RATE_MIN = 0.01;
const FX_RATE_MAX = 1000;

export function isPlausibleFxRate(r: unknown): r is number {
  return (
    typeof r === "number" &&
    Number.isFinite(r) &&
    r >= FX_RATE_MIN &&
    r <= FX_RATE_MAX
  );
}

// Fetch latest USD-base rates from open.er-api.com and return the slice for
// the supported currencies. Throws on transport / parse failure so the daily
// job records a clean failure rather than persisting silently.
async function fetchFxFromProvider(
  ctx: PluginContext,
): Promise<{ day: string; rates: Partial<Record<CurrencyCode, number>>; source: string }> {
  const res = await ctx.http.fetch(FX_PROVIDER_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`FX provider HTTP ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    result?: string;
    base_code?: string;
    time_last_update_utc?: string;
    rates?: Record<string, number>;
  };
  if (body.result !== "success" || !body.rates) {
    throw new Error(`FX provider returned an unexpected response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  // Use the provider's effective date if present; otherwise today (UTC).
  // The provider's day boundary is UTC.
  let day = fmtDay(new Date());
  if (body.time_last_update_utc) {
    const t = Date.parse(body.time_last_update_utc);
    if (!Number.isNaN(t)) day = new Date(t).toISOString().slice(0, 10);
  }
  const rates: Partial<Record<CurrencyCode, number>> = {};
  for (const c of SUPPORTED_CURRENCIES) {
    const r = body.rates[c];
    if (isPlausibleFxRate(r)) {
      rates[c] = r;
    } else if (r !== undefined) {
      // Provider returned a value but it's outside the sanity envelope.
      // Log and skip — better to fall through to the previous day's
      // stored row than to persist a catastrophic outlier.
      ctx.logger.warn("FX rate outside sanity envelope; skipping currency", {
        currency: c,
        provider_rate: r,
        min: FX_RATE_MIN,
        max: FX_RATE_MAX,
      });
    }
  }
  return { day, rates, source: FX_PROVIDER_NAME };
}

// Ensure today's row is present for every active currency. Idempotent — re-
// runs every hour but only writes when the row is actually missing or stale.
async function ensureTodaysFxRates(ctx: PluginContext): Promise<{
  fetched: boolean;
  day: string;
  written: CurrencyCode[];
  skipped: CurrencyCode[];
}> {
  const active = await loadActiveCurrencies(ctx);
  active.delete("USD"); // USD is identity; nothing to store.
  if (active.size === 0) {
    return { fetched: false, day: fmtDay(new Date()), written: [], skipped: [] };
  }
  // Already have today's row for every active currency? Skip the network.
  const today = fmtDay(new Date());
  const existingRows = await ctx.db.query<{ currency: string }>(
    `SELECT currency FROM ${q(ctx, "fx_rates")} WHERE day = $1`,
    [today],
  );
  const present = new Set(existingRows.map((r) => r.currency));
  const missing = Array.from(active).filter((c) => !present.has(c));
  if (missing.length === 0) {
    return { fetched: false, day: today, written: [], skipped: Array.from(active) };
  }
  // Fetch once, persist the rates we need.
  const { day, rates, source } = await fetchFxFromProvider(ctx);
  const written: CurrencyCode[] = [];
  const skipped: CurrencyCode[] = [];
  for (const c of active) {
    const r = rates[c];
    if (typeof r === "number" && r > 0) {
      await upsertFxRate(ctx, day, c, r, source);
      written.push(c);
    } else {
      skipped.push(c);
    }
  }
  return { fetched: true, day, written, skipped };
}

export function priceFor(
  rawModel: string,
  input: number,
  output: number,
  cfg: PricingConfig,
): { inputCost: number; outputCost: number } {
  const rate = lookupRate(
    { effective_from: "", config: cfg },
    rawModel,
  );
  if (!rate) return { inputCost: 0, outputCost: 0 };
  const mult = cfg.effective_input_rate_multiplier ?? 1;
  const inputCost = (input / 1_000_000) * rate.input * mult;
  const outputCost = (output / 1_000_000) * rate.output;
  return { inputCost, outputCost };
}

async function rollupCompanyDay(ctx: PluginContext, companyId: string, day: string): Promise<void> {
  // Atomic rebuild of usage_daily(company_id, day, *) from usage_events for
  // the same scope. The single UPSERT statement reads + writes in one DB
  // call, so concurrent invocations (cron vs live ingestEvent, or two live
  // ingests on the same day) cannot interleave a stale SELECT snapshot
  // with another writer's DELETE. PRIMARY KEY (company_id, day, model) on
  // usage_daily makes the ON CONFLICT clause well-defined.
  await ctx.db.execute(
    `INSERT INTO ${q(ctx, "usage_daily")}
       (company_id, day, model, input_tokens, output_tokens)
     SELECT company_id,
            day,
            model,
            COALESCE(SUM(input_tokens),  0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM ${q(ctx, "usage_events")}
      WHERE company_id = $1 AND day = $2
      GROUP BY company_id, day, model
     ON CONFLICT (company_id, day, model) DO UPDATE
       SET input_tokens  = EXCLUDED.input_tokens,
           output_tokens = EXCLUDED.output_tokens`,
    [companyId, day],
  );

  // Purge rolled-up rows for models that no longer have any events in this
  // (company, day) — happens after a correction or archive cleanup. The
  // UPSERT above can't see "removed" models on its own.
  await ctx.db.execute(
    `DELETE FROM ${q(ctx, "usage_daily")}
      WHERE company_id = $1
        AND day        = $2
        AND model NOT IN (
          SELECT DISTINCT model FROM ${q(ctx, "usage_events")}
           WHERE company_id = $1 AND day = $2
        )`,
    [companyId, day],
  );
}

// Backfill helper used by both backfillFromCostEvents (explicit range) and
// backfillAllHistory (since-first-event). Read public.cost_events for the
// range, ingest each row into usage_events with source_event_id
// `cost_event:<id>` (ON CONFLICT DO NOTHING), then rollup every affected
// day. Returns a summary of how many rows landed.
async function runBackfill(
  ctx: PluginContext,
  companyId: string,
  from: string,
  to: string,
): Promise<{
  scanned: number;
  inserted: number;
  daysRolledUp: number;
  days: string[];
}> {
  const fromIso = `${from}T00:00:00Z`;
  const toIso = `${to}T23:59:59.999Z`;

  type Row = {
    id: string;
    company_id: string;
    agent_id: string | null;
    model: string;
    input_tokens: number | string | null;
    cached_input_tokens: number | string | null;
    output_tokens: number | string | null;
    occurred_at: string;
  };

  const rows = await ctx.db.query<Row>(
    `SELECT id::text             AS id,
            company_id::text     AS company_id,
            agent_id::text       AS agent_id,
            model,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            occurred_at::text    AS occurred_at
       FROM public.cost_events
      WHERE company_id = $1::uuid
        AND provider = 'openai'
        AND occurred_at >= $2::timestamptz
        AND occurred_at <= $3::timestamptz`,
    [companyId, fromIso, toIso],
  );

  let inserted = 0;
  const affectedDays = new Set<string>();

  for (const r of rows) {
    const inp = Number(r.input_tokens) || 0;
    const cached = Number(r.cached_input_tokens) || 0;
    const out = Number(r.output_tokens) || 0;
    if (!inp && !cached && !out) continue;
    const day = String(r.occurred_at).slice(0, 10);
    const result = await ctx.db.execute(
      `INSERT INTO ${q(ctx, "usage_events")}
         (source_event_id, company_id, agent_id, model, input_tokens, output_tokens, occurred_at, day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_event_id) DO NOTHING`,
      [
        `cost_event:${r.id}`,
        r.company_id,
        r.agent_id,
        String(r.model ?? "unknown"),
        inp + cached,
        out,
        r.occurred_at,
        day,
      ],
    );
    if (result.rowCount > 0) inserted++;
    affectedDays.add(day);
  }

  for (const day of affectedDays) {
    await rollupCompanyDay(ctx, companyId, day);
  }

  ctx.logger.info("backfill complete", {
    companyId,
    from,
    to,
    scanned: rows.length,
    inserted,
    daysRolledUp: affectedDays.size,
  });
  return {
    scanned: rows.length,
    inserted,
    daysRolledUp: affectedDays.size,
    days: Array.from(affectedDays).sort(),
  };
}

async function ingestEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const e = event as unknown as Record<string, unknown>;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  // Plugin only ingests OpenAI events. Claude / Gemini / other-provider
  // events are handled by sibling plugins. Filter before any side effects
  // (no DB read, no DB write, no log write).
  const provider = String(
    payload.provider ?? payload.providerKey ?? "",
  ).toLowerCase();
  if (provider !== "openai") {
    return;
  }

  // Cost events get keyed by the cost_event row id ("cost_event:<id>") so
  // backfillFromCostEvents and live subscription land in the same keyspace —
  // a backfill window that overlaps the live ingest is a no-op via ON
  // CONFLICT DO NOTHING rather than double-counting. agent.run.finished
  // doesn't have a cost_event id, so it falls through to the PluginEvent
  // UUID (eventId) which the original ingestor used.
  const eventType = String(e.eventType ?? "");
  const costEventId =
    eventType === "cost_event.created"
      ? String(payload.id ?? payload.eventId ?? "")
      : "";
  const sourceEventId = costEventId
    ? `cost_event:${costEventId}`
    : String(
        e.eventId ?? (e as { id?: string }).id ?? payload.eventId ?? payload.id ?? "",
      );
  const companyId = String(e.companyId ?? payload.companyId ?? payload.company_id ?? "");
  const occurredAt = String(
    e.occurredAt ??
      payload.occurredAt ??
      payload.occurred_at ??
      new Date().toISOString(),
  );
  const agentId =
    (payload.agentId as string | undefined) ??
    (payload.agent_id as string | undefined) ??
    (e.actorType === "agent" ? ((e.actorId as string) ?? null) : null);
  const model = payload.model;
  // 2.0.0: no normalizer. model = raw_model = whatever the host emitted.
  // Pricing lookup is exact match against the operator's free-form table.
  const rawModel = typeof model === "string" ? model : "unknown";
  const inputTokens = Number(payload.inputTokens ?? payload.input_tokens ?? 0);
  const outputTokens = Number(payload.outputTokens ?? payload.output_tokens ?? 0);
  const cachedInputTokens = Number(
    payload.cachedInputTokens ?? payload.cached_input_tokens ?? 0,
  );
  // Costs page tracks source (subscription vs api) per event. Provider is
  // resolved + filtered to "openai" at the top of this function.
  const source = String(
    payload.source ?? payload.billing ?? payload.billingMode ?? "api",
  ).toLowerCase();
  const costCentsRaw =
    payload.costCents ??
    payload.cost_cents ??
    (typeof payload.costUsd === "number"
      ? Math.round((payload.costUsd as number) * 100)
      : typeof payload.cost_usd === "number"
        ? Math.round((payload.cost_usd as number) * 100)
        : undefined);
  const costCents =
    typeof costCentsRaw === "number" && isFinite(costCentsRaw)
      ? Math.round(costCentsRaw)
      : null;

  // Per-event telemetry at debug level. Operators can raise log level
  // when diagnosing silently-dropped events; default is quiet to avoid
  // dumping per-event billing data into the steady-state log stream.
  ctx.logger.debug("usage event received", {
    eventType: e.eventType ?? event.eventType,
    sourceEventId,
    companyId,
    agentId,
    rawModel,
    provider,
    source,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costCents,
    occurredAt,
    payloadKeys: Object.keys(payload),
  });

  if (!sourceEventId || !companyId) {
    ctx.logger.warn("usage event skipped: missing id or company", {
      sourceEventId,
      companyId,
    });
    return;
  }
  if (!inputTokens && !outputTokens && !cachedInputTokens) {
    // Zero-token events do exist (manual credits, refunds, etc.) — record nothing.
    return;
  }

  const totalInput = inputTokens + cachedInputTokens;

  await ctx.db.execute(
    `INSERT INTO ${q(ctx, "usage_events")}
       (source_event_id, company_id, agent_id, model, raw_model, provider, source,
        input_tokens, output_tokens, cached_input_tokens, cost_cents, occurred_at, day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (source_event_id) DO NOTHING`,
    [
      sourceEventId,
      companyId,
      agentId,
      rawModel,    // model — same as raw_model in 2.0.0
      rawModel,    // raw_model — preserved verbatim
      provider,
      source,
      totalInput,
      outputTokens || 0,
      cachedInputTokens || 0,
      costCents,
      occurredAt,
      toDay(occurredAt),
    ],
  );

  await rollupCompanyDay(ctx, companyId, toDay(occurredAt));
}

function buildMonthlyRows(
  daily: DailyRow[],
  snapshots: PricingSnapshot[],
): Array<{
  month: string;
  month_start: string;
  month_end: string;
  input_tokens: number;
  output_tokens: number;
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  total_billed_usd: number | null;
}> {
  const hasPricing = snapshots.length > 0;
  const buckets = new Map<
    string,
    {
      month: string;
      month_start: string;
      month_end: string;
      input_tokens: number;
      output_tokens: number;
      input_cost_usd: number;
      output_cost_usd: number;
      // Track per-bucket margin (USD) so multi-snapshot months use the
      // snapshot active at the bucket's month_end for the margin pass.
      margin_percent: number;
    }
  >();

  for (const row of daily) {
    const start = monthStart(new Date(row.day + "T00:00:00Z"));
    const key = monthKey(start);
    let bucket = buckets.get(key);
    if (!bucket) {
      const monthEndDay = fmtDay(monthEnd(start));
      const snap = findActiveSnapshot(snapshots, `${monthEndDay}T12:00:00Z`);
      bucket = {
        month: key,
        month_start: fmtDay(start),
        month_end: monthEndDay,
        input_tokens: 0,
        output_tokens: 0,
        input_cost_usd: 0,
        output_cost_usd: 0,
        margin_percent: snap?.config.margin.percent ?? 0,
      };
      buckets.set(key, bucket);
    }
    bucket.input_tokens += Number(row.input_tokens) || 0;
    bucket.output_tokens += Number(row.output_tokens) || 0;
    const snap = findActiveSnapshot(snapshots, `${row.day}T12:00:00Z`);
    const cfg = snap?.config ?? null;
    if (cfg) {
      const { inputCost, outputCost } = priceFor(
        row.model,
        Number(row.input_tokens) || 0,
        Number(row.output_tokens) || 0,
        cfg,
      );
      bucket.input_cost_usd += inputCost;
      bucket.output_cost_usd += outputCost;
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((b) => {
      const marginMultiplier = 1 + (b.margin_percent || 0) / 100;
      return {
        month: b.month,
        month_start: b.month_start,
        month_end: b.month_end,
        input_tokens: b.input_tokens,
        output_tokens: b.output_tokens,
        input_cost_usd: hasPricing ? Number(b.input_cost_usd.toFixed(4)) : null,
        output_cost_usd: hasPricing ? Number(b.output_cost_usd.toFixed(4)) : null,
        total_billed_usd: hasPricing
          ? Number(((b.input_cost_usd + b.output_cost_usd) * marginMultiplier).toFixed(4))
          : null,
      };
    });
}

async function readDaily(
  ctx: PluginContext,
  companyId: string,
  from: string,
  to: string,
): Promise<DailyRow[]> {
  return ctx.db.query<DailyRow>(
    `SELECT company_id, day, model, input_tokens, output_tokens
       FROM ${q(ctx, "usage_daily")}
      WHERE company_id = $1 AND day >= $2 AND day <= $3
      ORDER BY day DESC`,
    [companyId, from, to],
  );
}

// Slugify a free-text company name into something safe for a download
// filename: ASCII letters/digits/hyphens, no leading/trailing hyphens,
// capped at 40 chars. Returns "" when nothing survives (caller falls back
// to the UUID).
export function slugifyForFilename(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Client-facing CSV: one row per (calendar-month, model) showing tokens and
// the price the client owes — in the operator's chosen billing currency, with
// margin applied. Doesn't surface the operator's underlying USD cost or any
// other internal billing artifact. Each month's price is converted at the
// FX rate stored for that month's end day, so a year-spanning export uses
// each month's own contemporary rate rather than a single point-in-time
// snapshot.
async function buildClientMonthlyCsv(
  ctx: PluginContext,
  companyId: string,
  from: string,
  to: string,
): Promise<{ csv: string; currency: CurrencyCode }> {
  const snapshots = await loadAllSnapshots(ctx, companyId);
  const hasPricing = snapshots.length > 0;
  const currencyCfg = await loadCurrency(ctx, companyId);
  const daily = await readDaily(ctx, companyId, from, to);

  // Group by (month YYYY-MM, model). Track tokens here; price is computed
  // once per row after we know the right FX rate for that month. Per-row
  // snapshot resolution means historical periods bill against their own
  // contemporary snapshots.
  type Bucket = {
    month: string;
    month_start: string;
    month_end: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    // Margin captured at month_end snapshot — applied uniformly to the
    // whole month's cost when emitting the line.
    margin_percent: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const row of daily) {
    const start = monthStart(new Date(row.day + "T00:00:00Z"));
    const monthLabel = monthKey(start);
    const key = `${monthLabel}|${row.model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      const monthEndDay = fmtDay(monthEnd(start));
      const monthSnap = findActiveSnapshot(snapshots, `${monthEndDay}T12:00:00Z`);
      bucket = {
        month: monthLabel,
        month_start: fmtDay(start),
        month_end: monthEndDay,
        model: row.model,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        margin_percent: monthSnap?.config.margin.percent ?? 0,
      };
      buckets.set(key, bucket);
    }
    const inp = Number(row.input_tokens) || 0;
    const out = Number(row.output_tokens) || 0;
    bucket.input_tokens += inp;
    bucket.output_tokens += out;
    const snap = findActiveSnapshot(snapshots, `${row.day}T12:00:00Z`);
    const cfg = snap?.config ?? null;
    if (cfg) {
      const { inputCost, outputCost } = priceFor(row.model, inp, out, cfg);
      bucket.cost_usd += inputCost + outputCost;
    }
  }

  // Cache FX rates per month-end so we only hit getFxRate once per month.
  const fxByMonth = new Map<string, number>();
  for (const b of buckets.values()) {
    if (fxByMonth.has(b.month_end)) continue;
    const fx = await getFxRate(ctx, b.month_end, currencyCfg.currency);
    fxByMonth.set(b.month_end, fx?.rate ?? 1);
  }

  const rows = Array.from(buckets.values())
    .filter((b) => b.input_tokens + b.output_tokens > 0)
    .sort((a, b) => {
      if (a.month !== b.month) return a.month.localeCompare(b.month);
      const totalA = a.input_tokens + a.output_tokens;
      const totalB = b.input_tokens + b.output_tokens;
      return totalB - totalA;
    });

  const header = [
    "period", "month_start", "month_end", "model",
    "input_tokens", "output_tokens", "total_tokens", "currency", "price",
  ].map(csvCell).join(",");

  // Build per-row strings and accumulate per-month subtotals as we go. When
  // the export spans 2+ months we emit a "TOTAL" row after each month's
  // last per-model row so the client can read the monthly bill at a glance
  // without pivoting. Single-month exports skip subtotals — the one row
  // (or rows) IS the bill.
  const distinctMonths = new Set(rows.map((r) => r.month));
  const multiMonth = distinctMonths.size >= 2;

  type Subtotal = {
    month: string;
    month_start: string;
    month_end: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    price: number | null;
  };
  const subtotalByMonth = new Map<string, Subtotal>();
  const lines: string[] = [];

  for (const b of rows) {
    const total = b.input_tokens + b.output_tokens;
    const fxRate = fxByMonth.get(b.month_end) ?? 1;
    const margin = (b.margin_percent || 0) / 100;
    const priceNative = hasPricing
      ? b.cost_usd * (1 + margin) * fxRate
      : null;
    const snap = findActiveSnapshot(snapshots, `${b.month_end}T12:00:00Z`);
    const displayName = snap?.config.pricing[b.model]?.display_name ?? b.model;
    const modelLabel = displayName;
    lines.push(
      [
        b.month,
        b.month_start,
        b.month_end,
        modelLabel,
        b.input_tokens,
        b.output_tokens,
        total,
        currencyCfg.currency,
        priceNative === null ? "" : priceNative.toFixed(2),
      ].map(csvCell).join(","),
    );
    if (multiMonth) {
      let s = subtotalByMonth.get(b.month);
      if (!s) {
        s = {
          month: b.month,
          month_start: b.month_start,
          month_end: b.month_end,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          price: hasPricing ? 0 : null,
        };
        subtotalByMonth.set(b.month, s);
      }
      s.input_tokens += b.input_tokens;
      s.output_tokens += b.output_tokens;
      s.total_tokens += total;
      if (s.price !== null && priceNative !== null) s.price += priceNative;
    }
  }

  // Interleave the subtotal row after the last row of each month — scan the
  // emitted lines and inject TOTAL rows at month boundaries.
  let finalLines = lines;
  if (multiMonth) {
    const withSubtotals: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      withSubtotals.push(lines[i]);
      const thisMonth = rows[i].month;
      const nextMonth = i + 1 < rows.length ? rows[i + 1].month : null;
      const isLastOfMonth = thisMonth !== nextMonth;
      if (isLastOfMonth) {
        const s = subtotalByMonth.get(thisMonth);
        if (s) {
          withSubtotals.push(
            [
              s.month,
              s.month_start,
              s.month_end,
              "TOTAL",
              s.input_tokens,
              s.output_tokens,
              s.total_tokens,
              currencyCfg.currency,
              s.price === null ? "" : s.price.toFixed(2),
            ].map(csvCell).join(","),
          );
        }
      }
    }
    finalLines = withSubtotals;
  }

  return {
    csv: [header, ...finalLines].join("\n") + "\n",
    currency: currencyCfg.currency,
  };
}

// ---------- Costs overview (mirrors the host /costs page card) ----------

const ROLLING_WINDOWS: ReadonlyArray<{ key: "5h" | "24h" | "7d"; ms: number }> = [
  { key: "5h",  ms:        5 * 3600 * 1000 },
  { key: "24h", ms:       24 * 3600 * 1000 },
  { key: "7d",  ms: 7 * 24 * 3600 * 1000 },
];

interface CostsRollingWindow {
  windowKey: "5h" | "24h" | "7d";
  tokens: number;
  costUsd: number | null;
}

interface CostsSubscriptionSummary {
  runs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  subscriptionTokens: number;
  apiTokens: number;
  subscriptionShare: number;       // 0..1
}

interface CostsModelRow {
  rawModel: string;                 // verbatim host-emitted model string
  normalizedKey: string;            // same as rawModel in 2.0.0 (no normalization)
  provider: string;                 // e.g. "anthropic"
  source: string;                   // e.g. "subscription" | "api"
  tokens: number;
  tokenShare: number;               // 0..1 across all rows
  costUsd: number | null;
}

// Per-agent breakdown (mirrors the host /costs page's "What each agent consumed" section).
// One row per agent, with a nested per-(rawModel,source) sub-list.
interface CostsAgentModelRow {
  rawModel: string;                 // verbatim host-emitted model string
  normalizedKey: string;            // same as rawModel in 2.0.0
  provider: string;
  source: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  agentTokenShare: number;          // 0..1 within this agent's total
  costUsd: number | null;
}

interface CostsAgentRow {
  agentId: string;                  // raw event agent id (may be a UUID or a slug)
  agentName: string;                // resolved via ctx.agents.list; falls back to "Agent <short-id>"
  agentTitle: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  apiRuns: number;
  subscriptionRuns: number;
  costUsd: number | null;
  models: CostsAgentModelRow[];
}

interface CostsOverview {
  asOf: string;
  windowStart: string;              // start of the longest window (7d)
  rollingWindows: CostsRollingWindow[];
  subscription: CostsSubscriptionSummary;
  perModel: CostsModelRow[];
  perAgent: CostsAgentRow[];        // What each agent consumed in the 7d horizon.
  priced: boolean;                  // false → cost columns are null
  quotaNote: string;                // Claude CLI quota is host-local; we can't surface it.
}

function priceTokens(
  rawModel: string,
  input: number,
  output: number,
  cfg: PricingConfig | null,
): number | null {
  if (!cfg) return null;
  const { inputCost, outputCost } = priceFor(rawModel, input, output, cfg);
  const total = inputCost + outputCost;
  const marginMultiplier = 1 + (cfg.margin.percent || 0) / 100;
  return Number((total * marginMultiplier).toFixed(4));
}

async function buildCostsOverview(
  ctx: PluginContext,
  companyId: string,
): Promise<CostsOverview> {
  const snapshots = await loadAllSnapshots(ctx, companyId);
  const hasPricing = snapshots.length > 0;
  // Use the longest window as the read horizon so a single query feeds every bucket.
  const horizonMs = ROLLING_WINDOWS[ROLLING_WINDOWS.length - 1].ms;
  const now = new Date();
  const since = new Date(now.getTime() - horizonMs);

  const events = await ctx.db.query<{
    agent_id: string | null;
    raw_model: string | null;
    model: string;
    provider: string | null;
    source: string | null;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cost_cents: number | null;
    occurred_at: string;
  }>(
    `SELECT agent_id, raw_model, model, provider, source,
            input_tokens, output_tokens, cached_input_tokens, cost_cents,
            occurred_at
       FROM ${q(ctx, "usage_events")}
      WHERE company_id = $1 AND occurred_at >= $2`,
    [companyId, since.toISOString()],
  );

  // Rolling windows.
  const rollingWindows: CostsRollingWindow[] = ROLLING_WINDOWS.map(({ key, ms }) => {
    const start = new Date(now.getTime() - ms).getTime();
    let tokens = 0;
    let costUsd = 0;
    let hasCost = false;
    for (const e of events) {
      const t = new Date(e.occurred_at).getTime();
      if (t < start) continue;
      const inp = Number(e.input_tokens) || 0;
      const out = Number(e.output_tokens) || 0;
      tokens += inp + out;
      const snap = findActiveSnapshot(snapshots, e.occurred_at);
      const cfg = snap?.config ?? null;
      const priced = priceTokens(e.model, inp, out, cfg);
      if (priced !== null) {
        costUsd += priced;
        hasCost = true;
      }
    }
    return {
      windowKey: key,
      tokens,
      costUsd: hasCost ? Number(costUsd.toFixed(4)) : null,
    };
  });

  // Subscription summary — 7d horizon, mirrors the host card's "runs · total · in · out" line.
  let runs = 0;
  let subTokens = 0;
  let apiTokens = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const e of events) {
    runs++;
    const inp = Number(e.input_tokens) || 0;
    const out = Number(e.output_tokens) || 0;
    totalIn += inp;
    totalOut += out;
    const src = (e.source || "api").toLowerCase();
    if (src === "subscription") subTokens += inp + out;
    else apiTokens += inp + out;
  }
  const totalTokens = subTokens + apiTokens;
  const subscriptionShare = totalTokens > 0 ? subTokens / totalTokens : 0;

  // Per-model breakdown — group by raw_model (with [1m] suffix preserved).
  // Cost is accumulated per-event so each event uses its own active snapshot;
  // historical periods bill against their contemporary snapshot.
  const perModelMap = new Map<
    string,
    {
      rawModel: string;
      normalizedKey: string;
      provider: string;
      source: string;
      tokens: number;
      input: number;
      output: number;
      costAccumUsd: number;
      hasCost: boolean;
    }
  >();
  for (const e of events) {
    const rawModel = e.raw_model || e.model || "unknown";
    const provider = (e.provider || "anthropic").toLowerCase();
    const source = (e.source || "api").toLowerCase();
    const key = `${rawModel}|${provider}|${source}`;
    let bucket = perModelMap.get(key);
    if (!bucket) {
      bucket = {
        rawModel,
        normalizedKey: e.model,
        provider,
        source,
        tokens: 0,
        input: 0,
        output: 0,
        costAccumUsd: 0,
        hasCost: false,
      };
      perModelMap.set(key, bucket);
    }
    const inp = Number(e.input_tokens) || 0;
    const out = Number(e.output_tokens) || 0;
    bucket.input += inp;
    bucket.output += out;
    bucket.tokens += inp + out;
    const snap = findActiveSnapshot(snapshots, e.occurred_at);
    const cfg = snap?.config ?? null;
    const priced = priceTokens(e.model, inp, out, cfg);
    if (priced !== null) {
      bucket.costAccumUsd += priced;
      bucket.hasCost = true;
    }
  }
  const perModelRaw = Array.from(perModelMap.values()).sort((a, b) => b.tokens - a.tokens);
  const grandTokens = perModelRaw.reduce((sum, r) => sum + r.tokens, 0);
  const perModel: CostsModelRow[] = perModelRaw.map((r) => ({
    rawModel: r.rawModel,
    normalizedKey: r.normalizedKey,
    provider: r.provider,
    source: r.source,
    tokens: r.tokens,
    tokenShare: grandTokens > 0 ? r.tokens / grandTokens : 0,
    costUsd: r.hasCost ? Number(r.costAccumUsd.toFixed(4)) : null,
  }));

  // ---------- Per-agent breakdown (mirrors host /costs "What each agent consumed") ----------
  // Group events by agent_id, then within each agent group by (rawModel, source).
  // Run counts increment per-event so we can show "0 api · N subscription" like the host does.
  type AgentBucket = {
    agentId: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    apiRuns: number;
    subscriptionRuns: number;
    costAccumUsd: number;
    hasCost: boolean;
    models: Map<string, {
      rawModel: string;
      normalizedKey: string;
      provider: string;
      source: string;
      tokens: number;
      input: number;
      output: number;
      costAccumUsd: number;
      hasCost: boolean;
    }>;
  };
  const perAgentMap = new Map<string, AgentBucket>();
  for (const e of events) {
    if (!e.agent_id) continue;
    const agentId = e.agent_id;
    let agent = perAgentMap.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        apiRuns: 0,
        subscriptionRuns: 0,
        costAccumUsd: 0,
        hasCost: false,
        models: new Map(),
      };
      perAgentMap.set(agentId, agent);
    }
    const inp = Number(e.input_tokens) || 0;
    const out = Number(e.output_tokens) || 0;
    const src = (e.source || "api").toLowerCase();
    agent.inputTokens += inp;
    agent.outputTokens += out;
    agent.totalTokens += inp + out;
    if (src === "subscription") agent.subscriptionRuns++;
    else agent.apiRuns++;
    const snap = findActiveSnapshot(snapshots, e.occurred_at);
    const cfg = snap?.config ?? null;
    const priced = priceTokens(e.model, inp, out, cfg);
    if (priced !== null) {
      agent.costAccumUsd += priced;
      agent.hasCost = true;
    }
    const rawModel = e.raw_model || e.model || "unknown";
    const provider = (e.provider || "anthropic").toLowerCase();
    const modelKey = `${rawModel}|${provider}|${src}`;
    let m = agent.models.get(modelKey);
    if (!m) {
      m = {
        rawModel,
        normalizedKey: e.model,
        provider,
        source: src,
        tokens: 0,
        input: 0,
        output: 0,
        costAccumUsd: 0,
        hasCost: false,
      };
      agent.models.set(modelKey, m);
    }
    m.input += inp;
    m.output += out;
    m.tokens += inp + out;
    if (priced !== null) {
      m.costAccumUsd += priced;
      m.hasCost = true;
    }
  }

  // Resolve agent_id → display name. Single ctx.agents.list call covers the whole company.
  // Falls back to "Agent <short-id>" when the id isn't in the company (e.g. terminated agents).
  type AgentLite = { id: string; name?: string | null; title?: string | null };
  let agentDirectory = new Map<string, AgentLite>();
  try {
    const agents = (await ctx.agents.list({ companyId })) as unknown as AgentLite[];
    for (const a of agents) agentDirectory.set(a.id, a);
  } catch (err) {
    // agents.read not granted, or transient host error. Names just won't resolve;
    // costs still render with fallback labels.
    ctx.logger?.warn?.("ctx.agents.list failed; per-agent names will fall back to ids", {
      error: String(err instanceof Error ? err.message : err),
    });
  }

  const perAgent: CostsAgentRow[] = Array.from(perAgentMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((a) => {
      const directoryHit = agentDirectory.get(a.agentId);
      const shortId = a.agentId.length > 8 ? a.agentId.slice(0, 8) : a.agentId;
      const models = Array.from(a.models.values())
        .sort((m1, m2) => m2.tokens - m1.tokens)
        .map((m) => ({
          rawModel: m.rawModel,
          normalizedKey: m.normalizedKey,
          provider: m.provider,
          source: m.source,
          tokens: m.tokens,
          inputTokens: m.input,
          outputTokens: m.output,
          agentTokenShare: a.totalTokens > 0 ? m.tokens / a.totalTokens : 0,
          costUsd: m.hasCost ? Number(m.costAccumUsd.toFixed(4)) : null,
        }));
      return {
        agentId: a.agentId,
        agentName: directoryHit?.name || `Agent ${shortId}`,
        agentTitle: directoryHit?.title || null,
        totalTokens: a.totalTokens,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        apiRuns: a.apiRuns,
        subscriptionRuns: a.subscriptionRuns,
        costUsd: a.hasCost ? Number(a.costAccumUsd.toFixed(4)) : null,
        models,
      };
    });

  return {
    asOf: now.toISOString(),
    windowStart: since.toISOString(),
    rollingWindows,
    subscription: {
      runs,
      totalTokens,
      inputTokens: totalIn,
      outputTokens: totalOut,
      subscriptionTokens: subTokens,
      apiTokens,
      subscriptionShare,
    },
    perModel,
    perAgent,
    priced: hasPricing,
    quotaNote:
      "Claude CLI subscription quota windows (Current session / Current week) are host-local — not exposed via the cost_event.created bus, so this card omits them.",
  };
}

let capturedCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    capturedCtx = ctx;
    ctx.logger.info("openai-token-cost-reports starting up", {
      namespace: ctx.db.namespace,
    });

    ctx.events.on("cost_event.created", async (event) => {
      await ingestEvent(ctx, event);
    });

    ctx.events.on("agent.run.finished", async (event) => {
      await ingestEvent(ctx, event);
    });

    // Cleanup hook: when a company's status flips to "archived" we purge its
    // rows from usage_events, usage_daily, pricing_config, and the
    // company-scoped state so we don't keep stale references after the
    // operator removes the company. Idempotent — re-firing on subsequent
    // company.updated events just DELETEs zero rows.
    ctx.events.on("company.updated", async (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const status = String(payload.status ?? "").toLowerCase();
      if (status !== "archived") return;
      const companyId = String(event.companyId ?? payload.id ?? "");
      if (!companyId) return;
      try {
        const ev = await ctx.db.execute(
          `DELETE FROM ${q(ctx, "usage_events")} WHERE company_id = $1`,
          [companyId],
        );
        const da = await ctx.db.execute(
          `DELETE FROM ${q(ctx, "usage_daily")} WHERE company_id = $1`,
          [companyId],
        );
        const pc = await ctx.db.execute(
          `DELETE FROM ${q(ctx, "pricing_config")} WHERE company_id = $1`,
          [companyId],
        );
        // Best-effort state cleanup. Failures here are logged but not fatal —
        // the SQL rows are gone, which is the larger footprint.
        try {
          await ctx.state.delete(currencyScope(companyId));
        } catch {
          /* tolerate */
        }
        try {
          await ctx.state.delete(pricingScope(companyId));
        } catch {
          /* tolerate */
        }
        ctx.logger.info("archived company purged", {
          companyId,
          usageEvents: ev.rowCount,
          usageDaily: da.rowCount,
          pricingConfig: pc.rowCount,
        });
      } catch (err) {
        ctx.logger.warn("archived company cleanup failed", {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    ctx.jobs.register("rollup-daily", async (job) => {
      ctx.logger.info("rollup-daily run", { runId: job.runId, trigger: job.trigger });
      // Roll up today AND yesterday. Today handles the steady-state
      // live-ingest top-up. Yesterday catches late-arriving events with
      // occurred_at < today (rare but happens at midnight boundaries and
      // when a live ingestEvent failed mid-run) and any operator
      // correction to usage_events that doesn't touch usage_daily.
      const now = new Date();
      const today = fmtDay(now);
      const yesterday = fmtDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      const companies = await ctx.db.query<{ company_id: string }>(
        `SELECT DISTINCT company_id FROM ${q(ctx, "usage_events")} WHERE day IN ($1, $2)`,
        [today, yesterday],
      );
      for (const c of companies) {
        await rollupCompanyDay(ctx, c.company_id, today);
        await rollupCompanyDay(ctx, c.company_id, yesterday);
      }
    });

    // Daily FX fetcher. Runs hourly (7 past) but is a no-op when today's row
    // already exists for every active currency. Catching errors here is
    // important — the host doesn't retry plugin jobs, and a stale FX row is
    // less bad than a worker that hard-fails on every wake.
    ctx.jobs.register("fetch-fx-daily", async (job) => {
      try {
        const result = await ensureTodaysFxRates(ctx);
        ctx.logger.info("fetch-fx-daily run", {
          runId: job.runId,
          trigger: job.trigger,
          ...result,
        });
      } catch (err) {
        ctx.logger.warn("fetch-fx-daily failed", {
          runId: job.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Read-only fetchers used by the UI's usePluginData(...) hooks live on
    // ctx.data.register, NOT ctx.actions.register. The host wires data and
    // actions through separate registries; usePluginData calls into the data
    // registry while usePluginAction calls into the actions registry. The
    // earlier mismatch caused every getter (pricing, daily, monthly, costs,
    // ingest) to silently no-op in the UI, falling back to default state.
    ctx.data.register("getDailyUsage", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");

      const snapshots = await loadAllSnapshots(ctx, companyId);
      const hasPricing = snapshots.length > 0;
      const currencyCfg = await loadCurrency(ctx, companyId);
      const fx = await getFxRate(ctx, to, currencyCfg.currency);
      const fxRate = fx?.rate ?? 1;
      // Surface the most-recent snapshot's margin as the "current"
      // marginPercent for the response — UIs use it for the chip; per-row
      // costs apply the per-day margin themselves.
      const latestCfg = snapshots[0]?.config ?? null;
      const rows = await readDaily(ctx, companyId, from, to);

      const byDay = new Map<string, {
        day: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        margin_percent: number;
      }>();

      for (const r of rows) {
        let bucket = byDay.get(r.day);
        const snap = findActiveSnapshot(snapshots, `${r.day}T12:00:00Z`);
        const cfg = snap?.config ?? null;
        if (!bucket) {
          bucket = {
            day: r.day,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            margin_percent: cfg?.margin.percent ?? 0,
          };
          byDay.set(r.day, bucket);
        }
        bucket.input_tokens += Number(r.input_tokens) || 0;
        bucket.output_tokens += Number(r.output_tokens) || 0;
        if (cfg) {
          const { inputCost, outputCost } = priceFor(
            r.model,
            Number(r.input_tokens) || 0,
            Number(r.output_tokens) || 0,
            cfg,
          );
          bucket.cost_usd += inputCost + outputCost;
        }
      }

      return {
        priced: hasPricing,
        currency: currencyCfg.currency,
        fxRate,
        fxDay: fx?.day ?? null,
        fxSource: fx?.source ?? null,
        marginPercent: latestCfg?.margin.percent ?? 0,
        rows: Array.from(byDay.values())
          .sort((a, b) => b.day.localeCompare(a.day))
          .map((r) => {
            const margin = (r.margin_percent || 0) / 100;
            const cost_usd = hasPricing ? r.cost_usd : null;
            const price_usd =
              cost_usd === null ? null : cost_usd * (1 + margin);
            const cost_native =
              cost_usd === null ? null : cost_usd * fxRate;
            const price_native =
              price_usd === null ? null : price_usd * fxRate;
            return {
              day: r.day,
              input_tokens: r.input_tokens,
              output_tokens: r.output_tokens,
              cost_usd:
                cost_usd === null ? null : Number(cost_usd.toFixed(4)),
              price_usd:
                price_usd === null ? null : Number(price_usd.toFixed(4)),
              cost_native:
                cost_native === null ? null : Number(cost_native.toFixed(4)),
              price_native:
                price_native === null
                  ? null
                  : Number(price_native.toFixed(4)),
              // Back-compat alias the dashboard's KPI uses.
              billable_usd:
                price_usd === null ? null : Number(price_usd.toFixed(4)),
            };
          }),
      };
    });

    ctx.data.register("getMonthlySummary", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");
      const snapshots = await loadAllSnapshots(ctx, companyId);
      const daily = await readDaily(ctx, companyId, from, to);
      return {
        priced: snapshots.length > 0,
        rows: buildMonthlyRows(daily, snapshots),
      };
    });

    // Per-model breakdown for the period. Feeds the dashboard's "By model"
    // chart: one row per model that appears in usage_daily for the range,
    // sorted by total_tokens desc. Drops "unknown" if it contributed zero.
    // Billable USD is filled when pricing is configured; null otherwise.
    ctx.data.register("getPerModelForRange", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");
      const snapshots = await loadAllSnapshots(ctx, companyId);
      const hasPricing = snapshots.length > 0;
      const latestCfg = snapshots[0]?.config ?? null;
      const currencyCfg = await loadCurrency(ctx, companyId);
      const fx = await getFxRate(ctx, to, currencyCfg.currency);
      const fxRate = fx?.rate ?? 1;
      const daily = await readDaily(ctx, companyId, from, to);

      // Margin for the period: use the snapshot active at `to` so the
      // displayed marginPercent matches the chargeback applied to the
      // per-model totals. Per-day costs already used the per-day snapshot
      // when accumulating; this margin reads the period-end policy.
      const periodEndSnap = findActiveSnapshot(snapshots, `${to}T12:00:00Z`);
      const margin = (periodEndSnap?.config.margin.percent ?? 0) / 100;

      const byModel = new Map<
        string,
        {
          input_tokens: number;
          output_tokens: number;
          cost_usd: number;
        }
      >();

      for (const r of daily) {
        const inp = Number(r.input_tokens) || 0;
        const out = Number(r.output_tokens) || 0;
        let bucket = byModel.get(r.model);
        if (!bucket) {
          bucket = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
          byModel.set(r.model, bucket);
        }
        bucket.input_tokens += inp;
        bucket.output_tokens += out;
        const snap = findActiveSnapshot(snapshots, `${r.day}T12:00:00Z`);
        const cfg = snap?.config ?? null;
        if (cfg) {
          const { inputCost, outputCost } = priceFor(r.model, inp, out, cfg);
          bucket.cost_usd += inputCost + outputCost;
        }
      }

      const rows = Array.from(byModel.entries())
        .map(([model, b]) => {
          const cost_usd = hasPricing ? b.cost_usd : null;
          const price_usd =
            cost_usd === null ? null : cost_usd * (1 + margin);
          const cost_native = cost_usd === null ? null : cost_usd * fxRate;
          const price_native =
            price_usd === null ? null : price_usd * fxRate;
          return {
            model,
            input_tokens: b.input_tokens,
            output_tokens: b.output_tokens,
            total_tokens: b.input_tokens + b.output_tokens,
            cost_usd: cost_usd === null ? null : Number(cost_usd.toFixed(4)),
            price_usd:
              price_usd === null ? null : Number(price_usd.toFixed(4)),
            cost_native:
              cost_native === null ? null : Number(cost_native.toFixed(4)),
            price_native:
              price_native === null ? null : Number(price_native.toFixed(4)),
            // Back-compat alias for the previous shape; existing UI code that
            // reads billable_usd keeps working until callers migrate.
            billable_usd:
              price_usd === null ? null : Number(price_usd.toFixed(4)),
          };
        })
        .filter((r) => r.total_tokens > 0)
        .sort((a, b) => b.total_tokens - a.total_tokens);

      return {
        priced: hasPricing,
        currency: currencyCfg.currency,
        fxRate,
        fxDay: fx?.day ?? null,
        fxSource: fx?.source ?? null,
        marginPercent: latestCfg?.margin.percent ?? 0,
        rows,
      };
    });

    ctx.data.register("getCostsOverview", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      return buildCostsOverview(ctx, companyId);
    });

    // Diagnostic: lets the UI confirm whether cost_event.created is actually
    // flowing to the worker. If totalEvents is 0 the host probably hasn't
    // granted `costs.read` — surface that to the operator instead of silently
    // showing empty cards.
    ctx.data.register("getIngestStats", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
      const [totalRow] = await ctx.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${q(ctx, "usage_events")} WHERE company_id = $1`,
        [companyId],
      );
      const [recentRow] = await ctx.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${q(ctx, "usage_events")}
          WHERE company_id = $1 AND occurred_at >= $2`,
        [companyId, since24h],
      );
      const [lastRow] = await ctx.db.query<{ occurred_at: string | null }>(
        `SELECT MAX(occurred_at) AS occurred_at FROM ${q(ctx, "usage_events")}
          WHERE company_id = $1`,
        [companyId],
      );
      const declaredCapabilities = ctx.manifest?.capabilities ?? [];
      const hasCostsRead = declaredCapabilities.includes("costs.read");
      return {
        asOf: now.toISOString(),
        totalEvents: totalRow?.n ?? 0,
        last24hEvents: recentRow?.n ?? 0,
        lastEventAt: lastRow?.occurred_at ?? null,
        hasCostsReadCapability: hasCostsRead,
        diagnosticHint:
          (totalRow?.n ?? 0) === 0
            ? hasCostsRead
              ? "No events ingested yet. cost_event.created subscriptions can take a few minutes to attach after install; if this persists check the host plugin logs."
              : "costs.read capability is NOT declared in the running manifest. Reinstall the plugin so the host re-evaluates capabilities."
            : null,
      };
    });

    ctx.data.register("getPricing", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const snapshots = await loadAllSnapshots(ctx, companyId);
      if (snapshots.length === 0) {
        return { pricing: DEFAULT_SEED_PRICING, hasSnapshot: false };
      }
      return { pricing: snapshots[0].config, hasSnapshot: true };
    });

    ctx.data.register("listPricingHistory", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const snapshots = await loadAllSnapshots(ctx, companyId);
      return { snapshots };
    });

    ctx.actions.register("setPricing", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const config = params.config as unknown;
      const validationError = validatePricingConfig(config);
      if (validationError) {
        throw new Error(`Invalid pricing config: ${validationError}`);
      }
      const now = new Date().toISOString();
      await insertSnapshot(ctx, companyId, now, config as PricingConfig, "via setPricing");
      ctx.logger.info("pricing snapshot appended", { companyId, effective_from: now });
      return { ok: true, effective_from: now };
    });

    ctx.actions.register("addPricingSnapshot", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const effectiveFrom = String(params.effective_from ?? "");
      if (!effectiveFrom) throw new Error("effective_from is required");
      if (Number.isNaN(Date.parse(effectiveFrom))) {
        throw new Error("effective_from must be an ISO 8601 UTC timestamp");
      }
      const config = params.config as unknown;
      const validationError = validatePricingConfig(config);
      if (validationError) {
        throw new Error(`Invalid pricing config: ${validationError}`);
      }
      const note = params.note ? String(params.note) : null;
      await insertSnapshot(ctx, companyId, effectiveFrom, config as PricingConfig, note);
      ctx.logger.info("pricing snapshot appended", { companyId, effective_from: effectiveFrom, note });
      return { ok: true, effective_from: effectiveFrom };
    });

    ctx.actions.register("revertToPricingSnapshot", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const sourceFrom = String(params.source_effective_from ?? "");
      if (!sourceFrom) throw new Error("source_effective_from is required");
      const [src] = await ctx.db.query<{ config_json: PricingConfig }>(
        `SELECT config_json FROM ${q(ctx, "pricing_config_history")}
          WHERE company_id = $1 AND effective_from = $2::timestamptz`,
        [companyId, sourceFrom],
      );
      if (!src) throw new Error(`no snapshot found at effective_from=${sourceFrom}`);
      const now = new Date().toISOString();
      await insertSnapshot(
        ctx,
        companyId,
        now,
        src.config_json,
        `revert to ${sourceFrom}`,
      );
      ctx.logger.info("pricing snapshot reverted", {
        companyId,
        source_effective_from: sourceFrom,
        new_effective_from: now,
      });
      return { ok: true, effective_from: now, source_effective_from: sourceFrom };
    });

    // ---- Currency + FX ---------------------------------------------------

    ctx.data.register("getCurrencyConfig", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const cfg = await loadCurrency(ctx, companyId);
      return { ...cfg, supported: SUPPORTED_CURRENCIES };
    });

    ctx.actions.register("setCurrencyConfig", async (params) => {
      const companyId = String(params.companyId ?? "");
      const currency = params.currency;
      if (!companyId) throw new Error("companyId is required");
      if (!isCurrencyCode(currency)) {
        throw new Error(`Unsupported currency. Pick one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
      }
      await ctx.state.set(currencyScope(companyId), { currency });
      await noteActiveCurrency(ctx, currency);
      // Best-effort fetch so the dashboard reflects the new currency
      // immediately rather than waiting up to an hour for the job to run.
      // Failures are non-fatal — the daily job will retry next hour.
      try {
        await ensureTodaysFxRates(ctx);
      } catch (err) {
        ctx.logger.warn("FX prefetch after setCurrencyConfig failed", {
          companyId,
          currency,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      ctx.logger.info("currency saved", { companyId, currency });
      return { ok: true };
    });

    // Status surface for the settings UI: which currency is configured, when
    // was the last FX fetch for it, and what was the latest rate.
    ctx.data.register("getFxStatus", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const cfg = await loadCurrency(ctx, companyId);
      const today = fmtDay(new Date());
      const fx = await getFxRate(ctx, today, cfg.currency);
      return {
        currency: cfg.currency,
        provider: FX_PROVIDER_NAME,
        rate: fx?.rate ?? null,
        rateDay: fx?.day ?? null,
        rateSource: fx?.source ?? null,
        identity: cfg.currency === "USD",
      };
    });

    // Manual refresh button in Settings. Same idempotent path as the job.
    ctx.actions.register("refreshFxNow", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (companyId) {
        // Mark this currency active so the result actually gets written.
        const cfg = await loadCurrency(ctx, companyId);
        await noteActiveCurrency(ctx, cfg.currency);
      }
      try {
        const result = await ensureTodaysFxRates(ctx);
        return { ok: true, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    });

    // Per-agent breakdown for the period. Used by the dashboard's By-agent
    // card. Aggregates usage_events by (agent_id, model), counts runs (rows),
    // sums tokens, prices via priceFor + (1 + margin), and converts to the
    // company's billing currency at the FX rate for the END of the range.
    // Agent display names come from ctx.agents.list (capability: agents.read).
    ctx.data.register("getPerAgentBreakdown", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");

      const snapshots = await loadAllSnapshots(ctx, companyId);
      const hasPricing = snapshots.length > 0;
      const latestCfg = snapshots[0]?.config ?? null;
      const currencyCfg = await loadCurrency(ctx, companyId);
      const fx = await getFxRate(ctx, to, currencyCfg.currency);

      // Widen GROUP BY to include `day` so each row resolves to its own
      // per-day snapshot during in-memory pricing. The reduction back to
      // (agent_id, model) happens below after costs are accumulated.
      const rows = await ctx.db.query<{
        agent_id: string | null;
        model: string;
        day: string;
        runs: number | string;
        input_tokens: number | string;
        output_tokens: number | string;
      }>(
        `SELECT agent_id,
                model,
                day,
                COUNT(*)            AS runs,
                SUM(input_tokens)   AS input_tokens,
                SUM(output_tokens)  AS output_tokens
           FROM ${q(ctx, "usage_events")}
          WHERE company_id = $1 AND day >= $2 AND day <= $3
          GROUP BY agent_id, model, day`,
        [companyId, from, to],
      );

      // Resolve agent names. List once, then keep the map; agents are small per
      // company. Falls back gracefully if any id isn't found (deleted agent).
      const nameByAgent = new Map<string, string>();
      try {
        const agents = await ctx.agents.list({ companyId });
        for (const a of agents) {
          // The Agent type ships with `name` per @paperclipai/shared.
          const n = (a as unknown as { name?: string }).name;
          if (a.id && typeof n === "string") nameByAgent.set(a.id, n);
        }
      } catch (err) {
        ctx.logger.warn("agents.list failed; falling back to ids", {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const fxRate = fx?.rate ?? 1;

      type ModelLine = {
        model: string;
        runs: number;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number | null;
        price_usd: number | null;
        cost_native: number | null;
        price_native: number | null;
      };
      type AgentBlock = {
        agentId: string | null;
        agentName: string;
        // Per-(agent, model) accumulator. We hold a Map during the loop so
        // multiple per-day rows for the same model merge in-place; the final
        // shape exposes `models` as an array.
        modelMap: Map<string, ModelLine>;
        totals: {
          runs: number;
          input_tokens: number;
          output_tokens: number;
          cost_usd: number | null;
          price_usd: number | null;
          cost_native: number | null;
          price_native: number | null;
        };
      };

      const byAgent = new Map<string, AgentBlock>();

      for (const r of rows) {
        const inp = Number(r.input_tokens) || 0;
        const out = Number(r.output_tokens) || 0;
        const runs = Number(r.runs) || 0;
        const snap = findActiveSnapshot(snapshots, `${r.day}T12:00:00Z`);
        const cfg = snap?.config ?? null;
        const { inputCost, outputCost } = cfg
          ? priceFor(r.model, inp, out, cfg)
          : { inputCost: 0, outputCost: 0 };
        // cost_usd / cost_native = raw list-price equivalent in USD / display currency.
        // price_usd / price_native = chargeback after margin (margin is per-day
        // because the operator can shift it via a snapshot mid-period).
        const dayMargin = cfg ? (cfg.margin.percent || 0) / 100 : 0;
        const row_cost_usd = cfg ? inputCost + outputCost : null;
        const row_price_usd =
          row_cost_usd === null ? null : row_cost_usd * (1 + dayMargin);
        const row_cost_native =
          row_cost_usd === null ? null : row_cost_usd * fxRate;
        const row_price_native =
          row_price_usd === null ? null : row_price_usd * fxRate;

        const agentId = r.agent_id;
        const key = agentId ?? "__unattributed__";
        let block = byAgent.get(key);
        if (!block) {
          block = {
            agentId,
            agentName:
              (agentId && nameByAgent.get(agentId)) ||
              (agentId ? agentId.slice(0, 8) : "Unattributed"),
            modelMap: new Map(),
            totals: {
              runs: 0,
              input_tokens: 0,
              output_tokens: 0,
              cost_usd: hasPricing ? 0 : null,
              price_usd: hasPricing ? 0 : null,
              cost_native: hasPricing ? 0 : null,
              price_native: hasPricing ? 0 : null,
            },
          };
          byAgent.set(key, block);
        }
        let line = block.modelMap.get(r.model);
        if (!line) {
          line = {
            model: r.model,
            runs: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: hasPricing ? 0 : null,
            price_usd: hasPricing ? 0 : null,
            cost_native: hasPricing ? 0 : null,
            price_native: hasPricing ? 0 : null,
          };
          block.modelMap.set(r.model, line);
        }
        line.runs += runs;
        line.input_tokens += inp;
        line.output_tokens += out;
        if (hasPricing && row_cost_usd !== null && row_price_usd !== null) {
          line.cost_usd = (line.cost_usd ?? 0) + row_cost_usd;
          line.price_usd = (line.price_usd ?? 0) + row_price_usd;
          line.cost_native = (line.cost_native ?? 0) + (row_cost_native ?? 0);
          line.price_native =
            (line.price_native ?? 0) + (row_price_native ?? 0);
        }
        block.totals.runs += runs;
        block.totals.input_tokens += inp;
        block.totals.output_tokens += out;
        if (hasPricing && row_cost_usd !== null && row_price_usd !== null) {
          block.totals.cost_usd = (block.totals.cost_usd ?? 0) + row_cost_usd;
          block.totals.price_usd =
            (block.totals.price_usd ?? 0) + row_price_usd;
          block.totals.cost_native =
            (block.totals.cost_native ?? 0) + (row_cost_native ?? 0);
          block.totals.price_native =
            (block.totals.price_native ?? 0) + (row_price_native ?? 0);
        }
      }

      // Round and sort once everything's accumulated.
      const result = Array.from(byAgent.values()).map((block) => ({
        agentId: block.agentId,
        agentName: block.agentName,
        models: Array.from(block.modelMap.values())
          .map((m) => ({
            ...m,
            cost_usd: m.cost_usd === null ? null : Number(m.cost_usd.toFixed(4)),
            price_usd:
              m.price_usd === null ? null : Number(m.price_usd.toFixed(4)),
            cost_native:
              m.cost_native === null ? null : Number(m.cost_native.toFixed(4)),
            price_native:
              m.price_native === null ? null : Number(m.price_native.toFixed(4)),
          }))
          .sort((a, b) =>
            (b.input_tokens + b.output_tokens) -
            (a.input_tokens + a.output_tokens),
          ),
        totals: {
          ...block.totals,
          cost_usd:
            block.totals.cost_usd === null
              ? null
              : Number(block.totals.cost_usd.toFixed(4)),
          price_usd:
            block.totals.price_usd === null
              ? null
              : Number(block.totals.price_usd.toFixed(4)),
          cost_native:
            block.totals.cost_native === null
              ? null
              : Number(block.totals.cost_native.toFixed(4)),
          price_native:
            block.totals.price_native === null
              ? null
              : Number(block.totals.price_native.toFixed(4)),
        },
      }));
      result.sort(
        (a, b) =>
          (b.totals.input_tokens + b.totals.output_tokens) -
          (a.totals.input_tokens + a.totals.output_tokens),
      );

      return {
        priced: hasPricing,
        currency: currencyCfg.currency,
        fxRate: fxRate,
        fxDay: fx?.day ?? null,
        fxSource: fx?.source ?? null,
        marginPercent: latestCfg?.margin.percent ?? 0,
        rows: result,
      };
    });

    // Backfill: read the host's historical cost_events for the company over a
    // date range and ingest them into our usage_events table. Idempotent —
    // source_event_id is prefixed `cost_event:<id>` so re-running the same range
    // is a no-op via ON CONFLICT DO NOTHING. After ingest, every affected day
    // is re-rolled-up so the dashboard catches up immediately.
    //
    // Token math mirrors the live ingest path: input_tokens + cached_input_tokens
    // both land in `input_tokens` because pricing applies the same rate to both
    // and the operator doesn't care about cache attribution at the bill level.
    ctx.actions.register("backfillFromCostEvents", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");
      return runBackfill(ctx, companyId, from, to);
    });

    // Backfill from the company's earliest recorded cost_event to today.
    // Convenience wrapper around runBackfill that finds MIN(occurred_at) first.
    // Useful right after install when you want a single click that catches
    // up *everything* without picking dates.
    ctx.actions.register("backfillAllHistory", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const [minRow] = await ctx.db.query<{ occurred_at: string | null }>(
        `SELECT MIN(occurred_at)::text AS occurred_at
           FROM public.cost_events
          WHERE company_id = $1::uuid
            AND provider = 'openai'`,
        [companyId],
      );
      const earliest = minRow?.occurred_at;
      if (!earliest) {
        return {
          scanned: 0,
          inserted: 0,
          daysRolledUp: 0,
          days: [] as string[],
          from: null,
          to: null,
          message: "No OpenAI cost events found for this company.",
        };
      }
      const from = earliest.slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const result = await runBackfill(ctx, companyId, from, to);
      return { ...result, from, to };
    });

    try {
      await runMigration2_0_0(ctx);
    } catch (err) {
      ctx.logger.warn("migration 2.0.0 failed; will retry on next worker restart", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (input.routeKey !== "export-monthly-csv") {
      return { status: 404, body: { error: "unknown route" } };
    }
    const ctx = capturedCtx;
    const companyId = input.companyId;
    const from = String(
      Array.isArray(input.query.from) ? input.query.from[0] : input.query.from ?? "",
    );
    const to = String(
      Array.isArray(input.query.to) ? input.query.to[0] : input.query.to ?? "",
    );
    if (!companyId || !isIsoDate(from) || !isIsoDate(to)) {
      return {
        status: 400,
        headers: { "content-type": "text/plain" },
        body: "companyId required; from + to must be YYYY-MM-DD",
      };
    }
    if (!ctx) return { status: 500, body: { error: "worker not initialized" } };
    const { csv, currency } = await buildClientMonthlyCsv(ctx, companyId, from, to);
    // Resolve a human-readable company slug for the filename. Falls back to
    // the company UUID if the lookup fails or the name doesn't slugify to
    // anything safe — clients shouldn't have to read UUIDs.
    let companySlug = companyId;
    try {
      const company = await ctx.companies.get(companyId);
      const slug = slugifyForFilename(company?.name ?? "");
      if (slug) companySlug = slug;
    } catch (err) {
      ctx.logger.warn("CSV company name lookup failed; falling back to UUID", {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Filename surfaces the company slug + currency code so the operator can
    // keep multi-period and multi-currency exports straight at a glance.
    const filename = `usage-${companySlug}-${from}-${to}-${currency}.csv`;
    return {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
      body: csv,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

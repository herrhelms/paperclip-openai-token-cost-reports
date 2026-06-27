import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  useHostContext,
  useHostNavigation,
  usePluginData,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import { DEFAULT_SEED_PRICING } from "../pricing";

// Host paths for the two surfaces this plugin contributes.
//
// Settings: the host mounts plugin settings under the instance settings tree at
//   /$COMPANY_HANDLE/settings/instance/plugins/<plugin-key>
// (slug accepted; the install UUID isn't exposed to the worker or UI host context).
//
// Usage page: the `page` slot's `routePath` is mounted by the host directly
// under the company prefix as `/:companyPrefix/<routePath>` — NOT under
// `/plugins/<pluginKey>/...`. The host validator requires routePath to be a
// single lowercase slug (letters/numbers/hyphens). With routePath:"tokens"
// the canonical page URL is /$COMPANY_HANDLE/tokens. linkProps() takes a
// company-relative path (leading slash, no company prefix) and the host
// resolves the prefix at render time.
const PLUGIN_KEY = "openai-token-cost-reports";
const USAGE_ROUTE_SLUG = "monthly-report-openai";
// Host router (confirmed against the installed bundle):
//   path:"company/settings/instance/plugins/:pluginId"
// — and :pluginId is the install UUID, NOT the plugin key. The UUID isn't
// available at build time, so we resolve it at runtime via GET /api/plugins,
// then build the settings href below. While the lookup is in flight we render
// the link with a #set-pricing fallback that does nothing harmful.
const SETTINGS_FALLBACK_HREF = "#set-pricing";
const USAGE_HREF = `/${USAGE_ROUTE_SLUG}`;

type PluginInstallSummary = { id: string; pluginKey: string };
let cachedInstallId: string | null = null;
let installIdPromise: Promise<string | null> | null = null;

async function fetchInstallId(): Promise<string | null> {
  if (cachedInstallId) return cachedInstallId;
  if (installIdPromise) return installIdPromise;
  installIdPromise = (async () => {
    try {
      const res = await fetch("/api/plugins", { credentials: "include" });
      if (!res.ok) return null;
      const list = (await res.json()) as PluginInstallSummary[];
      const match = list.find((p) => p.pluginKey === PLUGIN_KEY);
      cachedInstallId = match?.id ?? null;
      return cachedInstallId;
    } catch {
      return null;
    } finally {
      installIdPromise = null;
    }
  })();
  return installIdPromise;
}

// Resolve the active company's display name into a download-safe slug.
// Hits /api/companies/:id same-origin under the board's session (no plugin
// capability required — the host's REST is what the UI talks to anyway).
// Mirrors the worker-side slugifyForFilename so server and client agree on
// the filename written to Content-Disposition vs. <a download>.
const slugByCompanyId = new Map<string, string | null>();
function slugifyForFilename(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
async function fetchCompanySlug(companyId: string): Promise<string | null> {
  if (slugByCompanyId.has(companyId)) return slugByCompanyId.get(companyId) ?? null;
  try {
    const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}`, {
      credentials: "include",
    });
    if (!res.ok) {
      slugByCompanyId.set(companyId, null);
      return null;
    }
    const c = (await res.json()) as { name?: string };
    const slug = slugifyForFilename(c.name ?? "") || null;
    slugByCompanyId.set(companyId, slug);
    return slug;
  } catch {
    slugByCompanyId.set(companyId, null);
    return null;
  }
}

function useSettingsHref(): string {
  const [href, setHref] = useState<string>(
    cachedInstallId
      ? `/company/settings/instance/plugins/${cachedInstallId}`
      : SETTINGS_FALLBACK_HREF,
  );
  useEffect(() => {
    let cancelled = false;
    fetchInstallId().then((id) => {
      if (cancelled || !id) return;
      setHref(`/company/settings/instance/plugins/${id}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return href;
}

type DailyRow = {
  day: string;
  input_tokens: number;
  output_tokens: number;
  list_usd?: number | null;
  cost_usd?: number | null;
  price_usd?: number | null;
  list_native?: number | null;
  cost_native?: number | null;
  price_native?: number | null;
};

// Free-form rate table. Keys are any operator-supplied strings (raw OpenAI
// model identifiers like "gpt-5.5" or "o4-mini"). The worker's PricingConfig
// shape is mirrored here; we import DEFAULT_SEED_PRICING from ../pricing
// to share the seed table between worker and UI.
type RateRow = { input: number; output: number; display_name?: string };
type PricingConfig = {
  pricing: Record<string, RateRow>;
  margin: { percent: number };
  effective_input_rate_multiplier?: number;
};

type PricingSnapshot = {
  effective_from: string;
  config: PricingConfig;
  note?: string | null;
  created_at?: string;
  created_by?: string | null;
};

// Cross-engine timestamp parser for postgres timestamptz values returned via
// `::text`. Postgres formats these per the session's TimeZone setting and
// uses a space separator and a 2-digit offset (e.g. "2026-06-24 01:32:45+02"),
// which V8 accepts but Safari/Firefox historically reject. Normalize to
// strict ISO 8601 (T separator, `+HH:MM` offset, default to Z when absent)
// before handing to Date(). Returns null on parse failure so callers can
// fall back to rendering the raw string rather than "Invalid Date".
function parseTimestamp(raw: string): Date | null {
  let iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  iso = iso.replace(/([+-]\d{2})(?::?(\d{2}))?$/, (_, sign, mins) =>
    mins ? `${sign}:${mins}` : `${sign}:00`,
  );
  if (!/[Zz+-]\d?\d(?::\d{2})?$/.test(iso)) iso = `${iso}Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Walk common error shapes to find the human-readable message. SDK
// action errors arrive as plain objects ({ message, error, ... }), Error
// instances have .message, plain strings are themselves, and as a last
// resort we JSON.stringify so the operator at least sees the payload.
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.error === "string") return e.error;
    if (typeof e.body === "string") return e.body;
    const data = e.data as Record<string, unknown> | undefined;
    if (data && typeof data === "object") {
      if (typeof data.message === "string") return data.message;
      if (typeof data.error === "string") return data.error;
    }
    try {
      const dump = JSON.stringify(err);
      if (dump && dump !== "{}") return dump;
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

// Locate the PricingConfig inside any wrapping the worker's getPricing
// might apply. Walks at most two levels deep looking for an object that
// has a `pricing` key whose value is itself an object of RateRow-shaped
// entries.
function locatePricingConfig(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const candidates: Array<Record<string, unknown>> = [];
  candidates.push(raw as Record<string, unknown>);
  for (const c of [...candidates]) {
    if (c.pricing && typeof c.pricing === "object") {
      candidates.push(c.pricing as Record<string, unknown>);
    }
    if (c.data && typeof c.data === "object") {
      candidates.push(c.data as Record<string, unknown>);
    }
  }
  for (const c of candidates) {
    const p = c.pricing;
    if (!p || typeof p !== "object") continue;
    for (const v of Object.values(p as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const r = v as Record<string, unknown>;
        if (typeof r.input === "number" && typeof r.output === "number") {
          return c;
        }
      }
    }
  }
  return null;
}

function normalizePricing(raw: unknown): PricingConfig | null {
  const source = locatePricingConfig(raw);
  if (!source) {
    if (raw !== null && raw !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        "[openai-token-cost-reports] normalizePricing could not find a rate table in getPricing response",
        raw,
      );
    }
    return null;
  }
  const p = source.pricing as Record<string, unknown>;
  const out: PricingConfig = {
    pricing: {},
    margin: { percent: 0 },
    effective_input_rate_multiplier: 1,
  };
  for (const [key, row] of Object.entries(p)) {
    if (!row || typeof row !== "object") continue;
    const r2 = row as Record<string, unknown>;
    if (typeof r2.input !== "number" || typeof r2.output !== "number") continue;
    const next: RateRow = { input: r2.input, output: r2.output };
    if (typeof r2.display_name === "string" && r2.display_name.length > 0) {
      next.display_name = r2.display_name;
    }
    out.pricing[key] = next;
  }
  const m = source.margin as { percent?: unknown } | undefined;
  if (m && typeof m.percent === "number") {
    out.margin.percent = m.percent;
  }
  const mult = (source as { effective_input_rate_multiplier?: unknown }).effective_input_rate_multiplier;
  if (typeof mult === "number" && Number.isFinite(mult) && mult > 0) {
    out.effective_input_rate_multiplier = mult;
  }
  return out;
}

function isoDateOffset(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

// Format an amount in a specific ISO-4217 currency. Uses Intl.NumberFormat so
// each currency gets its native symbol and decimals (e.g. JPY: no decimals).
function fmtMoney(
  amount: number | null | undefined,
  currency: string,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return "—";
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
      minimumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(amount);
  } catch {
    // Unknown ISO code — fall back to a plain "CODE 1.23" form.
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// Supported currencies must match the worker's SUPPORTED_CURRENCIES list.
const UI_CURRENCIES = [
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
type CurrencyCode = (typeof UI_CURRENCIES)[number];

type CurrencyConfigResponse = {
  currency: CurrencyCode;
  supported: ReadonlyArray<CurrencyCode>;
};

type FxStatusResponse = {
  currency: CurrencyCode;
  provider: string;
  rate: number | null;
  rateDay: string | null;
  rateSource: string | null;
  identity: boolean;
};

// Compact token formatter — matches the host /costs page's "39.6k tok" / "1.0M tok" style.
// Used in tight inline contexts: per-model bar labels, per-agent rows, chart axis.
function fmtTokens(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

// Precise token formatter for headline KPI cards where two decimals look
// better next to the currency values (€627.40 reads next to 141.70M).
function fmtTokensPrecise(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toLocaleString();
}

// Host theme integration: the Paperclip app defines shadcn-style CSS variables
// on :root (--background, --foreground, --card, --border, --muted,
// --muted-foreground, --primary, --primary-foreground, --accent, --destructive,
// --ring). The plugin UI runs same-origin so we reference them directly and
// inherit the host's light/dark theme automatically. No more custom palette,
// no media queries, no class-based dark-mode overrides.
// The host stores tokens as direct oklch() values (confirmed by inspecting
// /assets/index-*.css), so we reference them as var(--token), not
// hsl(var(--token)). The dark theme is toggled by a parent class on the host
// root; the cascade flows into our subtree automatically.
const THEME_CSS = `
.tu-root {
  color: var(--foreground);
  color-scheme: light dark;
}
.tu-root input[type="number"],
.tu-root input[type="date"] {
  color-scheme: light dark;
}
/*
 * KPI grid breakpoints.
 *
 * The dashboard has 6 KPI cards (Total · Input · Output · Cost · Net · Price).
 * Inline auto-fit with a fixed minmax would strand the 6th card on a half-empty
 * second row at common widths. Explicit breakpoints keep the layout balanced:
 *
 *   ≥1400px  → 6 across (one row, widescreen monitors)
 *   980–1399 → 3 × 2     (typical 13–15" laptop / split screen — user's target)
 *   640–979  → 2 × 3     (narrow window, tablet portrait)
 *   <640     → 1 column  (phone)
 */
.tu-kpi-row {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
@media (max-width: 1399.98px) {
  .tu-kpi-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 979.98px) {
  .tu-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 639.98px) {
  .tu-kpi-row { grid-template-columns: minmax(0, 1fr); }
}
`;

// Style tokens mapped to host CSS variables so the page tracks Paperclip's
// theme. Card shape (border radius, padding, border weight) mirrors the host's
// shadcn-style cards seen elsewhere in the app.
const styles = {
  page: {
    padding: "24px",
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: "var(--foreground)",
    maxWidth: 1200,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column" as const,
    gap: 20,
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap" as const,
    gap: 12,
  } as React.CSSProperties,
  headerLeft: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  } as React.CSSProperties,
  title: {
    fontSize: 22,
    fontWeight: 600,
    margin: 0,
    color: "var(--foreground)",
    letterSpacing: -0.2,
  } as React.CSSProperties,
  subtitle: {
    fontSize: 13,
    color: "var(--muted-foreground)",
    margin: 0,
  } as React.CSSProperties,
  controls: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  input: {
    padding: "6px 10px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 13,
    background: "var(--background)",
    color: "var(--foreground)",
  } as React.CSSProperties,
  btn: {
    padding: "6px 12px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  } as React.CSSProperties,
  btnPrimary: {
    padding: "6px 14px",
    border: "1px solid var(--primary)",
    borderRadius: 8,
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  btnGhost: {
    padding: "6px 10px",
    border: "1px solid transparent",
    borderRadius: 8,
    background: "transparent",
    color: "var(--foreground)",
    cursor: "pointer",
    fontSize: 13,
  } as React.CSSProperties,
  btnIcon: {
    width: 32,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
    padding: 0,
    fontSize: 14,
    lineHeight: 1,
  } as React.CSSProperties,

  // Card shells
  card: {
    border: "1px solid var(--border)",
    borderRadius: 12,
    background: "var(--card)",
    color: "var(--foreground)",
    padding: 20,
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 16,
    gap: 12,
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
    color: "var(--foreground)",
  } as React.CSSProperties,

  // KPI grid — column count is driven by the .tu-kpi-row media queries in
  // THEME_CSS so the layout snaps to 6 / 3×2 / 2×3 / 1-col at clean breakpoints.
  // Keep this block empty-but-present so existing call sites don't break.
  kpiRow: {} as React.CSSProperties,
  kpi: {
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 16,
    background: "var(--card)",
    color: "var(--foreground)",
  } as React.CSSProperties,
  kpiLabel: {
    fontSize: 11,
    color: "var(--muted-foreground)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.6,
    fontWeight: 600,
  } as React.CSSProperties,
  kpiValue: {
    fontSize: 26,
    fontWeight: 700,
    marginTop: 6,
    color: "var(--foreground)",
    fontVariantNumeric: "tabular-nums" as const,
    letterSpacing: -0.5,
  } as React.CSSProperties,
  kpiSub: {
    fontSize: 12,
    color: "var(--muted-foreground)",
    marginTop: 4,
  } as React.CSSProperties,

  // Per-model rows
  modelRow: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 160px) 1fr minmax(120px, auto)",
    gap: 12,
    alignItems: "center",
    paddingBlock: 6,
  } as React.CSSProperties,
  modelLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--foreground)",
  } as React.CSSProperties,
  modelNums: {
    fontSize: 12,
    color: "var(--muted-foreground)",
    fontVariantNumeric: "tabular-nums" as const,
    textAlign: "right" as const,
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  chartTrack: {
    height: 10,
    width: "100%",
    background: "var(--muted)",
    borderRadius: 999,
    overflow: "hidden" as const,
    display: "flex",
  } as React.CSSProperties,
  chartFillInput: {
    height: "100%",
    background: "var(--primary)",
  } as React.CSSProperties,
  chartFillOutput: {
    height: "100%",
    background: "var(--primary)",
    opacity: 0.45,
  } as React.CSSProperties,

  // Skeleton blocks for loading state
  skeleton: {
    background: "var(--muted)",
    borderRadius: 6,
    height: 14,
    width: "100%",
    opacity: 0.6,
  } as React.CSSProperties,

  // Table (used by SettingsPage)
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
    color: "var(--foreground)",
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--muted-foreground)",
    fontWeight: 600,
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  } as React.CSSProperties,
  td: {
    padding: "10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--foreground)",
  } as React.CSSProperties,

  empty: {
    padding: 24,
    textAlign: "center" as const,
    color: "var(--muted-foreground)",
    border: "1px dashed var(--border)",
    borderRadius: 12,
    background: "var(--card)",
  } as React.CSSProperties,
  link: {
    color: "var(--primary)",
    textDecoration: "underline",
    textUnderlineOffset: 3,
    fontSize: 13,
  } as React.CSSProperties,
  mutedLabel: {
    fontSize: 12,
    color: "var(--muted-foreground)",
  } as React.CSSProperties,
  noRateChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 8px",
    borderLeft: "3px solid #d97706",
    background: "rgba(217, 119, 6, 0.08)",
    borderRadius: 4,
    fontSize: 12,
  } as React.CSSProperties,
  noRateLink: {
    color: "#d97706",
    textDecoration: "underline",
    cursor: "pointer",
  } as React.CSSProperties,
};

function ThemeStyles(): JSX.Element {
  return <style>{THEME_CSS}</style>;
}


// ---- Page-level helpers (month anchor, range math) ----

type MonthAnchor = { year: number; month: number };

function todayMonth(): MonthAnchor {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function monthLabel(a: MonthAnchor): string {
  return new Date(Date.UTC(a.year, a.month, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function monthBounds(a: MonthAnchor): { from: string; to: string } {
  const start = new Date(Date.UTC(a.year, a.month, 1));
  const end = new Date(Date.UTC(a.year, a.month + 1, 0));
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

function prevMonth(a: MonthAnchor): MonthAnchor {
  const d = new Date(Date.UTC(a.year, a.month - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function nextMonth(a: MonthAnchor): MonthAnchor {
  const d = new Date(Date.UTC(a.year, a.month + 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function isFutureMonth(a: MonthAnchor): boolean {
  const cur = todayMonth();
  return a.year > cur.year || (a.year === cur.year && a.month > cur.month);
}

// Per-model shape returned by the worker's getPerModelForRange handler.
// list/cost/price are null (not 0) when the model has no rate row in the
// active pricing config — the UI uses null to render the "no rate set" chip.
type PerModelRow = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  list_usd: number | null;
  cost_usd: number | null;
  price_usd: number | null;
  list_native: number | null;
  cost_native: number | null;
  price_native: number | null;
};
type PerModelResponse = {
  priced: boolean;
  currency?: CurrencyCode;
  fxRate?: number;
  fxDay?: string | null;
  fxSource?: string | null;
  marginPercent?: number;
  rows: PerModelRow[];
};

// Daily shape returned by getDailyUsage. The worker wraps rows in { priced, rows },
// not a bare array — the previous UI read the wrapper as the array and silently
// produced zeros. This page reads .rows.
type DailyResponse = {
  priced: boolean;
  currency?: CurrencyCode;
  fxRate?: number;
  fxDay?: string | null;
  marginPercent?: number;
  rows: DailyRow[];
};

// Per-agent breakdown shape returned by getPerAgentBreakdown.
type PerAgentModelLine = {
  model: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  list_usd: number | null;
  cost_usd: number | null;
  price_usd: number | null;
  list_native: number | null;
  cost_native: number | null;
  price_native: number | null;
};
type PerAgentBlock = {
  agentId: string | null;
  agentName: string;
  models: PerAgentModelLine[];
  totals: {
    runs: number;
    input_tokens: number;
    output_tokens: number;
    list_usd: number | null;
    cost_usd: number | null;
    price_usd: number | null;
    list_native: number | null;
    cost_native: number | null;
    price_native: number | null;
  };
};
type PerAgentResponse = {
  priced: boolean;
  currency: CurrencyCode;
  fxRate: number;
  fxDay: string | null;
  fxSource: string | null;
  marginPercent: number;
  effectiveInputRateMultiplier?: number;
  rows: PerAgentBlock[];
};

// Mirrors HostNavigationLinkProps loosely — the SDK marks href as optional.
type SettingsLinkProps = {
  href?: string;
  onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
};

// ---- Sub-components ----

/**
 * Always-visible billing-config strip. Renders the inputs that turn raw token
 * counts into the billable total: period, currency + FX, margin. The point is
 * auditability — anyone looking at the dashboard can defend the totals without
 * opening Settings.
 */
function BillingConfigStrip(props: {
  from: string;
  to: string;
  currency: CurrencyCode;
  fxRate: number | null;
  fxDay: string | null;
  fxSource: string | null;
  marginPercent: number | null;
  priced: boolean;
  settingsLinkProps: SettingsLinkProps;
}): JSX.Element {
  const {
    from,
    to,
    currency,
    fxRate,
    fxDay,
    fxSource,
    marginPercent,
    priced,
    settingsLinkProps,
  } = props;

  const cell: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: "var(--muted-foreground)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: 600,
  };
  const valueStyle: React.CSSProperties = {
    fontSize: 13,
    color: "var(--foreground)",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <section
      style={{
        border: "1px solid var(--border)",
        background: "var(--muted)",
        borderRadius: 6,
        padding: "10px 14px",
        display: "flex",
        flexWrap: "wrap",
        gap: 24,
        alignItems: "center",
        margin: "16px 0",
      }}
      title="Inputs to the billable total. Edit in Settings."
    >
      <div style={cell}>
        <span style={labelStyle}>Period</span>
        <span style={valueStyle}>
          {from} → {to}
        </span>
      </div>
      <div style={cell}>
        <span
          style={{
            ...labelStyle,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          Currency
          {fxRate !== null && fxRate !== 1 && (fxDay || fxSource) ? (
            <span
              role="img"
              aria-label={
                "FX rate" +
                (fxDay ? ` last fetched ${fxDay}` : "") +
                (fxSource ? ` from ${fxSource}` : "")
              }
              title={
                "Last fetched" +
                (fxDay ? `: ${fxDay}` : ": unknown") +
                (fxSource ? `\nSource: ${fxSource}` : "")
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                color: "var(--muted-foreground)",
                cursor: "help",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            </span>
          ) : null}
        </span>
        <span style={valueStyle}>
          {currency}
          {fxRate !== null && fxRate !== 1 ? (
            <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
              {" "}
              · 1 USD = {fxRate.toFixed(4)} {currency}
            </span>
          ) : null}
        </span>
      </div>
      <div style={cell}>
        <span style={labelStyle}>Margin</span>
        <span style={valueStyle}>
          {priced ? `${(marginPercent ?? 0).toFixed(1)}%` : "—"}
        </span>
      </div>
      <div style={{ ...cell, marginLeft: "auto" }}>
        <a {...settingsLinkProps} style={styles.link}>
          Edit in Settings →
        </a>
      </div>
    </section>
  );
}

// Health chip showing how many cost_event.created rows have landed in the
// last 24h. Three states: healthy (>=1 in 24h), idle (0 in 24h but total > 0),
// blank (no events ever). The blank state is mostly for fresh installs and
// links to the Backfill button at the bottom of the chip's tooltip.
type IngestStatsResponse = {
  asOf: string;
  totalEvents: number;
  last24hEvents: number;
  lastEventAt: string | null;
  hasCostsReadCapability?: boolean;
  diagnosticHint?: string | null;
};
function IngestStatsChip(props: {
  data: IngestStatsResponse | undefined | null;
}): JSX.Element | null {
  const d = props.data;
  if (!d) return null;
  const idle = d.last24hEvents === 0 && d.totalEvents > 0;
  const noEvents = d.totalEvents === 0;
  const stripe = noEvents
    ? "var(--muted-foreground)"
    : idle
      ? "var(--destructive)"
      : "var(--primary)";
  const bg = noEvents
    ? "color-mix(in oklab, var(--muted-foreground) 12%, transparent)"
    : idle
      ? "color-mix(in oklab, var(--destructive) 12%, transparent)"
      : "color-mix(in oklab, var(--primary) 12%, transparent)";
  const label = noEvents
    ? "No events yet"
    : idle
      ? "Idle — 0 events in 24h"
      : `${d.last24hEvents} events in 24h`;
  const tooltipBits = [
    `Lifetime events ingested: ${d.totalEvents}`,
    d.lastEventAt ? `Last event: ${d.lastEventAt.slice(0, 19).replace("T", " ")}Z` : "Never seen an event",
    "Events arrive via the cost_event.created subscription. If this stays at 0 while agents are running, the host may not be granting costs.read or the adapter isn't emitting cost events.",
  ];
  return (
    <span
      title={tooltipBits.join("\n")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        border: `1px solid ${stripe}`,
        borderRadius: 999,
        background: bg,
        color: stripe,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// Small status chip that surfaces a stale FX rate. Hidden for USD (identity,
// no FX to be stale) and when fxDay is within 1 day of today. Otherwise shows
// "FX from N days ago" so the operator knows their prices reflect an older
// exchange rate — typically a sign the hourly fetch job has been failing.
function FxStalenessChip(props: {
  fxDay: string | null | undefined;
  currency: CurrencyCode;
}): JSX.Element | null {
  if (props.currency === "USD") return null;
  if (!props.fxDay) return null;
  const today = new Date().toISOString().slice(0, 10);
  const t1 = Date.parse(props.fxDay + "T00:00:00Z");
  const t2 = Date.parse(today + "T00:00:00Z");
  if (!isFinite(t1) || !isFinite(t2)) return null;
  const days = Math.floor((t2 - t1) / 86400000);
  if (days <= 1) return null;
  return (
    <span
      title={`FX rate stored on ${props.fxDay}. The daily fetch job runs hourly — if this keeps growing, check the worker logs for fetch-fx-daily failures.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        border: "1px solid var(--destructive)",
        borderRadius: 999,
        background: "color-mix(in oklab, var(--destructive) 12%, transparent)",
        color: "var(--destructive)",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      FX rate {days}d old
    </span>
  );
}

function KpiCard(props: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div style={styles.kpi}>
      <div style={styles.kpiLabel}>{props.label}</div>
      <div style={styles.kpiValue}>
        {props.loading ? (
          <div style={{ ...styles.skeleton, height: 24, width: "60%" }} />
        ) : (
          props.value
        )}
      </div>
      {props.sub ? <div style={styles.kpiSub}>{props.sub}</div> : null}
    </div>
  );
}

function PerModelCard(props: {
  loading: boolean;
  rows: PerModelRow[] | null;
  priced: boolean;
  currency: CurrencyCode;
  settingsLinkProps: SettingsLinkProps;
  settingsHref: string;
  pricingConfig: PricingConfig | null;
}) {
  if (props.loading) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>By model</h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ ...styles.skeleton, height: 22 }} />
          ))}
        </div>
      </section>
    );
  }
  const rows = props.rows ?? [];
  if (rows.length === 0) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>By model</h2>
        </div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No model usage recorded for this period.
        </div>
      </section>
    );
  }
  const maxTotal = Math.max(...rows.map((r) => r.total_tokens), 1);
  return (
    <section style={styles.card}>
      <div style={styles.cardHeader}>
        <h2 style={styles.sectionTitle}>By model</h2>
        <span style={styles.mutedLabel}>
          {props.priced
            ? `Tokens · List → Your cost → Client price (${props.currency})`
            : "Tokens (Input · Output)"}
        </span>
      </div>
      <div>
        {rows.map((r) => {
          const totalPct = (r.total_tokens / maxTotal) * 100;
          const inputShare =
            r.total_tokens > 0 ? r.input_tokens / r.total_tokens : 0;
          const inputPct = totalPct * inputShare;
          const outputPct = totalPct * (1 - inputShare);
          const label =
            props.pricingConfig?.pricing[r.model]?.display_name ?? r.model;
          return (
            <div key={r.model} style={styles.modelRow}>
              <div style={styles.modelLabel}>{label}</div>
              <div style={styles.chartTrack} aria-hidden>
                <div
                  style={{ ...styles.chartFillInput, width: `${inputPct}%` }}
                />
                <div
                  style={{ ...styles.chartFillOutput, width: `${outputPct}%` }}
                />
              </div>
              <div style={styles.modelNums}>
                {fmtTokens(r.total_tokens)} tok
                {props.priced ? (
                  r.cost_usd === null ? (
                    <>
                      {" · "}
                      <span style={styles.noRateChip}>
                        no rate set
                        <a
                          href={settingsUrlForAddRate(r.model, props.settingsHref)}
                          style={styles.noRateLink}
                        >
                          add rate →
                        </a>
                      </span>
                    </>
                  ) : r.price_native !== null ? (
                    ` · ${fmtMoney(
                      r.list_native ?? r.cost_native,
                      props.currency,
                    )} → ${fmtMoney(r.cost_native, props.currency)} → ${fmtMoney(
                      r.price_native,
                      props.currency,
                    )}`
                  ) : (
                    ""
                  )
                ) : (
                  ""
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!props.priced ? (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <a {...props.settingsLinkProps} style={styles.link}>
            Set pricing →
          </a>{" "}
          to show cost and client price.
        </div>
      ) : null}
    </section>
  );
}

function PerAgentCard(props: {
  loading: boolean;
  data: PerAgentResponse | null;
  settingsLinkProps: SettingsLinkProps;
  settingsHref: string;
  pricingConfig: PricingConfig | null;
}) {
  if (props.loading) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>By agent</h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ ...styles.skeleton, height: 28 }} />
          ))}
        </div>
      </section>
    );
  }
  const d = props.data;
  const blocks = d?.rows ?? [];
  if (blocks.length === 0) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>By agent</h2>
        </div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No agent activity recorded for this period.
        </div>
      </section>
    );
  }
  const priced = !!d?.priced;
  const currency: CurrencyCode = (d?.currency ?? "USD") as CurrencyCode;

  const colHead: React.CSSProperties = {
    fontSize: 11,
    color: "var(--muted-foreground)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: 600,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    textAlign: "right",
    whiteSpace: "nowrap",
  };
  const colHeadLeft: React.CSSProperties = { ...colHead, textAlign: "left" };
  const cell: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 13,
    color: "var(--foreground)",
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
    whiteSpace: "nowrap",
  };
  const subRowCell: React.CSSProperties = {
    ...cell,
    fontSize: 12,
    color: "var(--muted-foreground)",
    borderTop: "1px dashed var(--border)",
  };
  const subRowLeft: React.CSSProperties = { ...subRowCell, textAlign: "left" };
  const totalCell: React.CSSProperties = {
    ...cell,
    fontWeight: 600,
    background: "var(--muted)",
  };
  const totalLeft: React.CSSProperties = {
    ...totalCell,
    textAlign: "left",
  };

  return (
    <section style={styles.card}>
      <div style={styles.cardHeader}>
        <h2 style={styles.sectionTitle}>By agent</h2>
        <span style={styles.mutedLabel}>
          {priced
            ? `Tokens · Runs · List → Your cost → Client price (${currency})`
            : "Tokens · Runs"}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={colHeadLeft}>Agent / Model</th>
              <th style={colHead}>Runs</th>
              <th style={colHead}>Input</th>
              <th style={colHead}>Output</th>
              {priced && <th style={colHead}>List</th>}
              {priced && <th style={colHead}>Your cost</th>}
              {priced && <th style={colHead}>Client price</th>}
            </tr>
          </thead>
          <tbody>
            {blocks.map((block, blockIdx) => (
              <React.Fragment key={block.agentId ?? `agent-${blockIdx}`}>
                <tr>
                  <td style={totalLeft}>{block.agentName}</td>
                  <td style={totalCell}>{fmtInt(block.totals.runs)}</td>
                  <td style={totalCell}>
                    {fmtTokens(block.totals.input_tokens)}
                  </td>
                  <td style={totalCell}>
                    {fmtTokens(block.totals.output_tokens)}
                  </td>
                  {priced && (
                    <td style={totalCell}>
                      {fmtMoney(
                        block.totals.list_native ?? block.totals.cost_native,
                        currency,
                      )}
                    </td>
                  )}
                  {priced && (
                    <td style={totalCell}>
                      {fmtMoney(block.totals.cost_native, currency)}
                    </td>
                  )}
                  {priced && (
                    <td style={totalCell}>
                      {fmtMoney(block.totals.price_native, currency)}
                    </td>
                  )}
                </tr>
                {block.models.map((m) => (
                  <tr key={`${block.agentId ?? "u"}-${m.model}`}>
                    <td style={subRowLeft}>
                      <span style={{ color: "var(--muted-foreground)", marginRight: 8 }}>
                        └
                      </span>
                      {props.pricingConfig?.pricing[m.model]?.display_name ??
                        m.model}
                    </td>
                    <td style={subRowCell}>{fmtInt(m.runs)}</td>
                    <td style={subRowCell}>{fmtTokens(m.input_tokens)}</td>
                    <td style={subRowCell}>{fmtTokens(m.output_tokens)}</td>
                    {priced && (
                      <td style={subRowCell}>
                        {m.cost_usd === null ? (
                          <span style={styles.noRateChip}>
                            no rate set
                            <a
                              href={settingsUrlForAddRate(m.model, props.settingsHref)}
                              style={styles.noRateLink}
                            >
                              add rate →
                            </a>
                          </span>
                        ) : (
                          fmtMoney(m.list_native ?? m.cost_native, currency)
                        )}
                      </td>
                    )}
                    {priced && (
                      <td style={subRowCell}>
                        {m.cost_usd === null
                          ? "—"
                          : fmtMoney(m.cost_native, currency)}
                      </td>
                    )}
                    {priced && (
                      <td style={subRowCell}>
                        {m.cost_usd === null
                          ? "—"
                          : fmtMoney(m.price_native, currency)}
                      </td>
                    )}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {!priced ? (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <a {...props.settingsLinkProps} style={styles.link}>
            Set pricing →
          </a>{" "}
          to show per-agent cost and client price.
        </div>
      ) : (
        <div style={{ marginTop: 12, fontSize: 11, color: "var(--muted-foreground)" }}>
          <strong>Cost</strong> = tokens × per-1M rate ·{" "}
          <strong>Price</strong> = Cost × (1 + margin {d?.marginPercent ?? 0}%)
          {d?.fxRate && d.fxRate !== 1
            ? `, converted at 1 USD = ${d.fxRate.toFixed(4)} ${currency} (${d.fxDay ?? "?"})`
            : ""}
        </div>
      )}
    </section>
  );
}

function DailyChartCard(props: {
  loading: boolean;
  rows: DailyRow[];
  from: string;
  to: string;
}) {
  if (props.loading) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>Daily volume</h2>
        </div>
        <div style={{ ...styles.skeleton, height: 120, borderRadius: 8 }} />
      </section>
    );
  }
  // Build a dense day-by-day series from `from` to `to`, filling zero where the
  // rollup table has no row. Iterating bounded by `to` ensures we don't draw a
  // gap when usage only landed on some days. Input and output are tracked
  // separately so we can draw a stacked column (output on top, input below).
  const byDay = new Map<string, { input: number; output: number }>();
  for (const r of props.rows) {
    const inp = Number(r.input_tokens) || 0;
    const out = Number(r.output_tokens) || 0;
    const existing = byDay.get(r.day);
    if (existing) {
      existing.input += inp;
      existing.output += out;
    } else {
      byDay.set(r.day, { input: inp, output: out });
    }
  }
  const days: { day: string; input: number; output: number; total: number }[] = [];
  const cursor = new Date(props.from + "T00:00:00Z");
  const end = new Date(props.to + "T00:00:00Z");
  while (cursor.getTime() <= end.getTime() && days.length < 366) {
    const day = cursor.toISOString().slice(0, 10);
    const split = byDay.get(day) ?? { input: 0, output: 0 };
    days.push({ day, input: split.input, output: split.output, total: split.input + split.output });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const totalsZero = days.every((d) => d.total === 0);
  if (totalsZero) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>Daily volume</h2>
        </div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No usage recorded for this period yet.
        </div>
      </section>
    );
  }
  const maxTotal = Math.max(1, ...days.map((d) => d.total));
  const W = 1000;
  const H = 120;
  const gap = 2;
  const colW = Math.max(1, (W - gap * (days.length - 1)) / days.length);
  return (
    <section style={styles.card}>
      <div style={styles.cardHeader}>
        <h2 style={styles.sectionTitle}>Daily volume</h2>
        <span style={styles.mutedLabel}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              background: "var(--primary)",
              opacity: 0.45,
              borderRadius: 2,
              marginRight: 4,
              verticalAlign: "middle",
            }}
            aria-hidden
          />
          input
          <span style={{ marginInline: 6 }}>·</span>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              background: "var(--primary)",
              borderRadius: 2,
              marginRight: 4,
              verticalAlign: "middle",
            }}
            aria-hidden
          />
          output
          <span style={{ marginInline: 6 }}>·</span>
          peak {fmtTokens(maxTotal)} tok/day
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 120, display: "block" }}
        role="img"
        aria-label="Daily token volume (input + output) across the selected period"
      >
        {days.map((d, i) => {
          if (d.total <= 0) return null;
          // Total column height proportional to that day's total tokens, with
          // a 2px floor so days with tiny activity still register visually.
          const colH = Math.max(2, (d.total / maxTotal) * (H - 4));
          // Output sits on top (full opacity); input is the base (45%).
          // Compute each segment's height from the share of total tokens.
          const outShare = d.total > 0 ? d.output / d.total : 0;
          const outH = colH * outShare;
          const inpH = colH - outH;
          const x = i * (colW + gap);
          const inpY = H - inpH;
          const outY = H - colH;
          const r = Math.min(1.5, colW / 2);
          return (
            <g key={d.day}>
              {inpH > 0 ? (
                <rect
                  x={x}
                  y={inpY}
                  width={colW}
                  height={inpH}
                  rx={r}
                  ry={r}
                  fill="var(--primary)"
                  opacity={0.45}
                >
                  <title>{`${d.day}: ${fmtInt(d.input)} input · ${fmtInt(d.output)} output (${fmtInt(d.total)} total)`}</title>
                </rect>
              ) : null}
              {outH > 0 ? (
                <rect
                  x={x}
                  y={outY}
                  width={colW}
                  height={outH}
                  rx={r}
                  ry={r}
                  fill="var(--primary)"
                >
                  <title>{`${d.day}: ${fmtInt(d.input)} input · ${fmtInt(d.output)} output (${fmtInt(d.total)} total)`}</title>
                </rect>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontSize: 11,
          color: "var(--muted-foreground)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>{props.from}</span>
        <span>{props.to}</span>
      </div>
    </section>
  );
}

function settingsUrlForAddRate(modelKey: string, settingsHref: string): string {
  return `${settingsHref}#add-${encodeURIComponent(modelKey)}`;
}

export function UsagePage(): JSX.Element {
  const host = useHostContext();
  const nav = useHostNavigation();
  const toast = usePluginToast();
  const companyId = host?.companyId ?? "";
  const settingsHref = useSettingsHref();
  const settingsLinkProps = nav.linkProps(settingsHref);

  const [mode, setMode] = useState<"month" | "custom">("month");
  const [anchor, setAnchor] = useState<MonthAnchor>(() => todayMonth());
  const [customFrom, setCustomFrom] = useState(isoDateOffset(30));
  const [customTo, setCustomTo] = useState(isoDateOffset(0));
  const [downloading, setDownloading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const backfillFromCostEvents = usePluginAction("backfillFromCostEvents");
  const backfillAllAction = usePluginAction("backfillAllHistory");

  const { from, to } = useMemo(
    () =>
      mode === "month"
        ? monthBounds(anchor)
        : { from: customFrom, to: customTo },
    [mode, anchor, customFrom, customTo],
  );

  const daily = usePluginData<DailyResponse>("getDailyUsage", {
    companyId,
    from,
    to,
  });
  const perModel = usePluginData<PerModelResponse>("getPerModelForRange", {
    companyId,
    from,
    to,
  });
  const perAgent = usePluginData<PerAgentResponse>("getPerAgentBreakdown", {
    companyId,
    from,
    to,
  });
  const pricing = usePluginData<unknown>("getPricing", { companyId });
  const ingestStats = usePluginData<IngestStatsResponse>("getIngestStats", { companyId });

  const pricingConfig = useMemo(
    () => normalizePricing(pricing.data),
    [pricing.data],
  );
  const hasPricing = !!pricingConfig;
  const currency: CurrencyCode = (daily.data?.currency ??
    perModel.data?.currency ??
    perAgent.data?.currency ??
    "USD") as CurrencyCode;

  const dailyRows: DailyRow[] = useMemo(() => {
    const d = daily.data;
    // Tolerate the historical bare-array shape too, in case a caller swaps the
    // worker out from under us. Never crash on a wrong-shape response.
    if (Array.isArray(d)) return d as DailyRow[];
    if (d && typeof d === "object" && Array.isArray((d as DailyResponse).rows)) {
      return (d as DailyResponse).rows;
    }
    return [];
  }, [daily.data]);

  const totals = useMemo(() => {
    let inp = 0;
    let out = 0;
    let list_native = 0;
    let cost_native = 0;
    let price_native = 0;
    let hasCost = false;
    // Worker emits three tiers explicitly — list_native (raw OpenAI),
    // cost_native (list × multiplier), price_native (cost × (1 + margin/100)).
    // Each accumulates per-day so periods spanning snapshots with different
    // multipliers / margins still sum correctly.
    for (const r of dailyRows) {
      inp += Number(r.input_tokens) || 0;
      out += Number(r.output_tokens) || 0;
      if (typeof r.list_native === "number") {
        list_native += r.list_native;
        hasCost = true;
      }
      if (typeof r.cost_native === "number") {
        cost_native += r.cost_native;
        hasCost = true;
      }
      if (typeof r.price_native === "number") {
        price_native += r.price_native;
      }
    }
    return { inp, out, list_native, cost_native, price_native, hasCost };
  }, [dailyRows]);

  // Download the CSV by fetching it and triggering an anchor with the `download`
  // attribute. This forces a real save instead of inline render, which is what
  // window.open() does when the host's API layer drops Content-Disposition.
  const downloadCsv = useCallback(async () => {
    if (downloading || !companyId) return;
    setDownloading(true);
    const url = `/api/plugins/openai-token-cost-reports/api/export/monthly.csv?companyId=${encodeURIComponent(
      companyId,
    )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    // Filename mirrors the worker's Content-Disposition: company slug,
    // period, currency code. The browser ignores the server header when we
    // download a blob URL, so we resolve the slug here too. fetchCompanySlug
    // hits /api/companies/:id same-origin (board session) and caches.
    const companySlug = (await fetchCompanySlug(companyId)) ?? companyId;
    const filename = `usage-${companySlug}-${from}-${to}-${currency}.csv`;
    let blobUrl: string | null = null;
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: { Accept: "text/csv" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      // The host wraps plugin api responses in JSON regardless of the
      // worker's Content-Type header, so what comes back is a JSON-quoted
      // string of the CSV (literal "\\n", surrounding quotes, etc.).
      // Unwrap when we detect that shape so the downloaded file is the
      // real CSV — newlines, no quotes, no escape sequences. Falls back to
      // the raw text when parsing doesn't produce a string.
      const raw = await res.text();
      let csv = raw;
      if (raw.length > 0 && raw[0] === '"') {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === "string") csv = parsed;
        } catch {
          /* leave csv as raw */
        }
      }
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      toast?.({
        title: "Download failed",
        body: String(err instanceof Error ? err.message : err),
        tone: "error",
      });
    } finally {
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl!), 1000);
      setDownloading(false);
    }
  }, [companyId, from, to, downloading, toast]);

  // Backfill historical cost_events into usage_events, then refresh.
  // Useful right after installing the plugin: the live subscription only
  // catches events going forward, but anything in public.cost_events for
  // this company and range can be ingested retroactively.
  const runBackfill = useCallback(async () => {
    if (backfilling || !companyId) return;
    setBackfilling(true);
    try {
      const result = (await backfillFromCostEvents({
        companyId,
        from,
        to,
      })) as { scanned: number; inserted: number; daysRolledUp: number };
      toast?.({
        title: "Backfill complete",
        body: `${result.inserted} new events ingested · ${result.daysRolledUp} day(s) re-rolled-up · scanned ${result.scanned}`,
        tone: "success",
      });
      daily.refresh();
      perModel.refresh();
      perAgent.refresh();
    } catch (err) {
      toast?.({
        title: "Backfill failed",
        body: String(err instanceof Error ? err.message : err),
        tone: "error",
      });
    } finally {
      setBackfilling(false);
    }
  }, [backfillFromCostEvents, backfilling, companyId, daily, from, perAgent, perModel, to, toast]);

  // Backfill all history: ask the worker to find the earliest cost_event for
  // this company and ingest from there to today. Asks for confirmation first
  // because the scan can take a minute on large histories.
  const runBackfillAll = useCallback(async () => {
    if (backfilling || !companyId) return;
    const ok = window.confirm(
      "This will scan every cost_event for this company since the very first one and ingest anything missing. Continue?",
    );
    if (!ok) return;
    setBackfilling(true);
    try {
      const result = (await backfillAllAction({ companyId })) as {
        scanned: number;
        inserted: number;
        daysRolledUp: number;
        from: string | null;
        to: string | null;
        message?: string;
      };
      if (result.message) {
        toast?.({ title: "Nothing to backfill", body: result.message, tone: "success" });
      } else {
        toast?.({
          title: "Full backfill complete",
          body: `${result.inserted} new events ingested · ${result.daysRolledUp} day(s) re-rolled-up · range ${result.from} → ${result.to}`,
          tone: "success",
        });
      }
      daily.refresh();
      perModel.refresh();
      perAgent.refresh();
      ingestStats.refresh();
    } catch (err) {
      toast?.({
        title: "Full backfill failed",
        body: String(err instanceof Error ? err.message : err),
        tone: "error",
      });
    } finally {
      setBackfilling(false);
    }
  }, [backfillAllAction, backfilling, companyId, daily, ingestStats, perAgent, perModel, toast]);

  if (!companyId) {
    return (
      <div className="tu-root" style={styles.page}>
        <ThemeStyles />
        <div style={styles.empty}>
          No company context. Open this plugin from inside a Paperclip company.
        </div>
      </div>
    );
  }

  const canStepForward = !isFutureMonth(nextMonth(anchor));
  const isLoading = daily.loading || perModel.loading;

  return (
    <div className="tu-root" style={styles.page}>
      <ThemeStyles />

      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h1 style={styles.title}>Token Usage</h1>
            <IngestStatsChip data={ingestStats.data} />
            <FxStalenessChip fxDay={daily.data?.fxDay} currency={currency} />
          </div>
          <p style={styles.subtitle}>
            OpenAI tokens consumed by this company. Used for client billing.
          </p>
        </div>
        <div style={styles.controls}>
          <button
            type="button"
            style={styles.btnPrimary}
            onClick={downloadCsv}
            disabled={downloading}
          >
            {downloading ? "Preparing…" : "Download monthly CSV"}
          </button>
        </div>
      </div>

      {/* Time scope */}
      <div style={styles.controls}>
        {mode === "month" ? (
          <>
            <button
              type="button"
              aria-label="Previous month"
              style={styles.btnIcon}
              onClick={() => setAnchor(prevMonth(anchor))}
            >
              ◀
            </button>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                minWidth: 140,
                textAlign: "center",
              }}
            >
              {monthLabel(anchor)}
            </div>
            <button
              type="button"
              aria-label="Next month"
              style={{
                ...styles.btnIcon,
                opacity: canStepForward ? 1 : 0.4,
                cursor: canStepForward ? "pointer" : "not-allowed",
              }}
              onClick={() => canStepForward && setAnchor(nextMonth(anchor))}
              disabled={!canStepForward}
            >
              ▶
            </button>
            <button
              type="button"
              style={styles.btnGhost}
              onClick={() => setMode("custom")}
            >
              Custom range
            </button>
          </>
        ) : (
          <>
            <label style={styles.mutedLabel}>From</label>
            <input
              type="date"
              style={styles.input}
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <label style={styles.mutedLabel}>To</label>
            <input
              type="date"
              style={styles.input}
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
            <button
              type="button"
              style={styles.btnGhost}
              onClick={() => setMode("month")}
            >
              ← Back to month view
            </button>
          </>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            style={styles.btn}
            onClick={runBackfill}
            disabled={backfilling}
            title="Scan the host's cost_events table for this period and ingest anything missing"
          >
            {backfilling ? "Backfilling…" : "Backfill this period"}
          </button>
          <button
            type="button"
            style={styles.btnGhost}
            onClick={runBackfillAll}
            disabled={backfilling}
            title="Scan since the earliest cost_event for this company and ingest anything missing"
          >
            Backfill all history
          </button>
        </div>
      </div>

      {/* KPI row */}
      {/* Always-visible audit strip — period · currency · margin. */}
      <BillingConfigStrip
        from={from}
        to={to}
        currency={currency}
        fxRate={perAgent.data?.fxRate ?? perModel.data?.fxRate ?? daily.data?.fxRate ?? null}
        fxDay={perAgent.data?.fxDay ?? perModel.data?.fxDay ?? daily.data?.fxDay ?? null}
        fxSource={perAgent.data?.fxSource ?? perModel.data?.fxSource ?? null}
        marginPercent={pricingConfig?.margin?.percent ?? perAgent.data?.marginPercent ?? null}
        priced={hasPricing}
        settingsLinkProps={settingsLinkProps}
      />

      {(() => {
        // KPI tiers (2.1.x):
        //   List price   = totals.list_native   (raw OpenAI, no knobs)
        //   Your cost    = totals.cost_native   (list × multiplier)
        //   Client price = totals.price_native  (your cost × (1 + margin))
        //
        // Sub-labels read the *effective* multiplier/margin off the actual
        // totals — when the period spans snapshots with different settings,
        // the latest config lies. The (mixed) suffix surfaces the mismatch.
        const latestMult = pricingConfig?.effective_input_rate_multiplier ?? 1;
        const latestMarginPct = pricingConfig?.margin?.percent ?? 0;
        const effectiveMult =
          totals.hasCost && totals.list_native > 0
            ? totals.cost_native / totals.list_native
            : latestMult;
        const effectiveMarginPct =
          totals.hasCost && totals.cost_native > 0
            ? (totals.price_native / totals.cost_native - 1) * 100
            : latestMarginPct;
        const multMixed =
          totals.hasCost && Math.abs(effectiveMult - latestMult) >= 0.005;
        const marginMixed =
          totals.hasCost &&
          Math.abs(effectiveMarginPct - latestMarginPct) >= 0.05;
        const formatMult = (m: number): string =>
          m >= 1 ? m.toFixed(2) : m.toFixed(3);
        const effectiveMultLabel = formatMult(effectiveMult);
        const effectiveMarginLabel = `${effectiveMarginPct.toFixed(
          effectiveMarginPct >= 10 ? 0 : 1,
        )}%`;
        return (
          <div className="tu-kpi-row" style={styles.kpiRow}>
            <KpiCard
              label="Total tokens"
              value={fmtTokensPrecise(totals.inp + totals.out)}
              loading={isLoading}
            />
            <KpiCard
              label="Input"
              value={fmtTokensPrecise(totals.inp)}
              loading={isLoading}
            />
            <KpiCard
              label="Output"
              value={fmtTokensPrecise(totals.out)}
              loading={isLoading}
            />
            <KpiCard
              label={`List price (${currency})`}
              value={
                hasPricing && totals.hasCost
                  ? fmtMoney(totals.list_native, currency)
                  : "—"
              }
              loading={isLoading}
              sub={
                !hasPricing ? (
                  <a {...settingsLinkProps} style={styles.link}>
                    Set pricing →
                  </a>
                ) : (
                  <span style={styles.kpiSub} title="tokens × per-1M OpenAI API rate">
                    tokens × per-1M API rate
                  </span>
                )
              }
            />
            <KpiCard
              label={`Your cost (${currency})`}
              value={
                hasPricing && totals.hasCost
                  ? fmtMoney(totals.cost_native, currency)
                  : "—"
              }
              loading={isLoading}
              sub={
                hasPricing ? (
                  <span style={styles.kpiSub}>
                    {multMixed
                      ? `effective ×${effectiveMultLabel} (mixed)`
                      : effectiveMult === 1
                        ? "no multiplier adjustment"
                        : `after multiplier ×${effectiveMultLabel}`}
                  </span>
                ) : undefined
              }
            />
            <KpiCard
              label={`Client price (${currency})`}
              value={
                hasPricing && totals.hasCost
                  ? fmtMoney(totals.price_native, currency)
                  : "—"
              }
              loading={isLoading}
              sub={
                hasPricing ? (
                  <span style={styles.kpiSub}>
                    Your cost · +{effectiveMarginLabel} margin
                    {marginMixed ? " (mixed)" : ""}
                  </span>
                ) : undefined
              }
            />
          </div>
        );
      })()}

      {/* By model */}
      <PerModelCard
        loading={perModel.loading}
        rows={perModel.data?.rows ?? null}
        priced={!!perModel.data?.priced}
        currency={currency}
        settingsLinkProps={settingsLinkProps}
        settingsHref={settingsHref}
        pricingConfig={pricingConfig}
      />

      {/* By agent */}
      <PerAgentCard
        loading={perAgent.loading}
        data={perAgent.data ?? null}
        settingsLinkProps={settingsLinkProps}
        settingsHref={settingsHref}
        pricingConfig={pricingConfig}
      />

      {/* Daily chart */}
      <DailyChartCard
        loading={daily.loading}
        rows={dailyRows}
        from={from}
        to={to}
      />

      {/* Pricing footer */}
      <section style={{ ...styles.card, padding: "12px 16px" }}>
        <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          {hasPricing && pricingConfig ? (
            <>
              Pricing configured: {Object.keys(pricingConfig.pricing).length}{" "}
              model rate{Object.keys(pricingConfig.pricing).length === 1 ? "" : "s"};
              margin {pricingConfig.margin.percent}%.{" "}
              <a {...settingsLinkProps} style={styles.link}>
                Edit rates →
              </a>
            </>
          ) : (
            <>
              Pricing not configured.{" "}
              <a {...settingsLinkProps} style={styles.link}>
                Set pricing →
              </a>{" "}
              to enable billable totals and the monthly CSV cost columns.
            </>
          )}
        </div>
      </section>
    </div>
  );
}


function HistoryPanel({ companyId }: { companyId: string }): JSX.Element {
  const history = usePluginData("listPricingHistory", { companyId });
  const clearAllAction = usePluginAction("clearAllPricing");
  const toast = usePluginToast();

  const snapshots =
    (history.data as { snapshots?: PricingSnapshot[] } | undefined)?.snapshots ??
    [];
  const snapshotCount = snapshots.length;
  const onClearAll = async () => {
    const ok = window.confirm(
      `Delete all ${snapshotCount} pricing snapshot${snapshotCount === 1 ? "" : "s"} for this company?\n\nUntil you save new pricing, cost and client price columns will show "—" for every period.\n\nThis cannot be undone.`,
    );
    if (!ok) return;
    try {
      const res = (await clearAllAction({ companyId })) as
        | { deleted?: number }
        | undefined;
      toast?.({
        title: "Snapshots cleared",
        body: `${res?.deleted ?? snapshotCount} snapshot${
          (res?.deleted ?? snapshotCount) === 1 ? "" : "s"
        } removed. Save new pricing to start fresh.`,
        tone: "success",
      });
      history.refresh();
    } catch (err) {
      const msg = extractErrorMessage(err);
      toast?.({ title: "Clear failed", body: msg, tone: "error" });
    }
  };

  // Section header + Clear-all button render unconditionally so the
  // destructive action's only safety net (the button itself) doesn't
  // vanish along with the list it just emptied.
  return (
    <section style={{ marginTop: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <h3 style={{ fontSize: 14, margin: 0 }}>Pricing snapshots</h3>
        <button
          type="button"
          style={{ marginLeft: "auto", ...styles.btnGhost }}
          onClick={onClearAll}
          disabled={snapshotCount === 0 || history.loading}
          title="Delete every pricing snapshot for this company"
        >
          Clear all
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--tu-muted, #888)", maxWidth: 640 }}>
        Saving pricing replaces the active snapshot and reprices every event
        in this company. Period-by-period historical overrides can be added
        via the addPricingSnapshot action.
      </p>
      {history.loading ? (
        <div style={{ fontSize: 12, color: "var(--tu-muted, #888)" }}>
          Loading history…
        </div>
      ) : snapshotCount === 0 ? (
        <div style={{ fontSize: 12, color: "var(--tu-muted, #888)" }}>
          No snapshot history yet. Save pricing once to create the first snapshot.
        </div>
      ) : null}
      <ul style={{ listStyle: "none", padding: 0, marginTop: 12 }}>
        {snapshots.map((s) => {
          const ratecount = Object.keys(s.config.pricing ?? {}).length;
          const mult = s.config.effective_input_rate_multiplier;
          // setPricing stamps "applies to everything" snapshots at the unix
          // epoch — render a meaningful label rather than "1/1/1970" and
          // surface the actual save time via created_at next to it.
          const effectiveAt = parseTimestamp(s.effective_from);
          const isEpoch =
            effectiveAt !== null && effectiveAt.getTime() <= 0;
          const headerLabel = isEpoch
            ? "Applies to every event"
            : effectiveAt
              ? `From ${effectiveAt.toLocaleString()}`
              : `From ${s.effective_from}`;
          const savedAt = s.created_at ? parseTimestamp(s.created_at) : null;
          const savedAtLabel = savedAt
            ? `saved ${savedAt.toLocaleString()}`
            : s.created_at
              ? `saved ${s.created_at}`
              : null;
          return (
            <li
              key={s.effective_from}
              style={{
                padding: "10px 12px",
                marginBottom: 8,
                background: "var(--muted, rgba(255,255,255,0.04))",
                borderLeft: "3px solid var(--primary, #6366f1)",
                borderRadius: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{headerLabel}</strong>
                <span style={{ fontSize: 12, color: "var(--tu-muted, #888)" }}>
                  · {ratecount} rate row{ratecount === 1 ? "" : "s"} · margin{" "}
                  {s.config.margin?.percent ?? 0}%
                  {mult !== undefined && mult !== 1 && ` · multiplier ${mult}`}
                  {savedAtLabel ? ` · ${savedAtLabel}` : ""}
                </span>
              </div>
              {s.note && (
                <div style={{ fontSize: 12, color: "var(--tu-muted, #888)", marginTop: 4 }}>
                  Note: {s.note}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function SettingsPage(): JSX.Element {
  const host = useHostContext();
  const nav = useHostNavigation();
  const companyId = host?.companyId ?? "";
  const usageLinkProps = nav.linkProps(USAGE_HREF);
  const pricing = usePluginData<unknown>("getPricing", { companyId });
  const currencyConfig = usePluginData<CurrencyConfigResponse>(
    "getCurrencyConfig",
    { companyId },
  );
  const fxStatus = usePluginData<FxStatusResponse>("getFxStatus", { companyId });
  const setPricing = usePluginAction("setPricing");
  const setCurrencyAction = usePluginAction("setCurrencyConfig");
  const refreshFxAction = usePluginAction("refreshFxNow");
  const toast = usePluginToast();

  const [config, setConfig] = useState<PricingConfig>({
    pricing: {},
    margin: { percent: 0 },
    effective_input_rate_multiplier: 1,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [refreshingFx, setRefreshingFx] = useState(false);

  useEffect(() => {
    const normalized = normalizePricing(pricing.data);
    if (normalized) setConfig(normalized);
  }, [pricing.data]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    const m = hash.match(/^#add-(.+)$/);
    if (!m) return;
    const key = decodeURIComponent(m[1]);
    const tid = window.setTimeout(() => {
      const form = document.querySelector<HTMLFormElement>("form[data-add-rate]");
      if (form) {
        form.scrollIntoView({ behavior: "smooth" });
        const keyInput = form.querySelector<HTMLInputElement>('input[name="key"]');
        if (keyInput) {
          keyInput.value = key;
          keyInput.focus();
        }
      }
    }, 50);
    return () => window.clearTimeout(tid);
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await setPricing({ companyId, config: config as unknown as Record<string, unknown> });
      setSaveError(null);
      toast?.({ title: "Pricing saved", tone: "success" });
      pricing.refresh();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setSaveError(msg);
      toast?.({ title: "Save failed", body: msg, tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  const onCurrencyChange = async (next: CurrencyCode) => {
    setSavingCurrency(true);
    try {
      await setCurrencyAction({ companyId, currency: next });
      toast?.({
        title: `Billing currency set to ${next}`,
        body:
          next === "USD"
            ? "USD is the base currency — no FX conversion applied."
            : "Latest FX rate fetched. Dashboard now displays prices in the new currency.",
        tone: "success",
      });
      currencyConfig.refresh();
      fxStatus.refresh();
    } catch (err) {
      toast?.({
        title: "Could not save currency",
        body: String(err instanceof Error ? err.message : err),
        tone: "error",
      });
    } finally {
      setSavingCurrency(false);
    }
  };

  const onRefreshFx = async () => {
    setRefreshingFx(true);
    try {
      const result = (await refreshFxAction({ companyId })) as {
        ok: boolean;
        fetched?: boolean;
        day?: string;
        written?: string[];
        skipped?: string[];
        error?: string;
      };
      if (!result.ok) throw new Error(result.error || "FX refresh failed");
      toast?.({
        title: result.fetched
          ? `FX refreshed for ${result.day}`
          : "FX is already up to date",
        body: result.fetched
          ? `Written: ${(result.written ?? []).join(", ") || "—"}`
          : undefined,
        tone: "success",
      });
      fxStatus.refresh();
    } catch (err) {
      toast?.({
        title: "FX refresh failed",
        body: String(err instanceof Error ? err.message : err),
        tone: "error",
      });
    } finally {
      setRefreshingFx(false);
    }
  };

  if (!companyId) {
    return (
      <div className="tu-root" style={styles.page}><ThemeStyles />
        <div style={styles.empty}>No company context available.</div>
      </div>
    );
  }

  const sortedRows = Object.entries(config.pricing).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <div className="tu-root" style={styles.page}><ThemeStyles />
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <h1 style={styles.title}>Token Usage Settings</h1>
        <a {...usageLinkProps} style={styles.link}>
          Open usage dashboard →
        </a>
      </div>
      <p style={{ color: "var(--tu-muted)", fontSize: 13, marginTop: 4 }}>
        Pricing configured here is consumed by the dashboard at{" "}
        <a {...usageLinkProps} style={styles.link}>
          /{host?.companyPrefix ?? "$COMPANY_HANDLE"}/{USAGE_ROUTE_SLUG}
        </a>
        . Rates are in USD per 1M tokens. Defaults match the current public
        OpenAI API list prices from{" "}
        <a
          href="https://platform.openai.com/docs/pricing"
          target="_blank"
          rel="noreferrer"
          style={styles.link}
        >
          platform.openai.com/docs/pricing
        </a>
        . Edit any row if your contract or workload diverges from list price.
      </p>

      <table style={{ ...styles.table, marginTop: 16 }}>
        <thead>
          <tr>
            <th style={styles.th}>Model key</th>
            <th style={styles.th}>Display name</th>
            <th style={styles.th}>Input $/MTok</th>
            <th style={styles.th}>Output $/MTok</th>
            <th style={styles.th}>Delete</th>
          </tr>
        </thead>
        <tbody>
          {pricing.loading && sortedRows.length === 0 ? (
            <tr>
              <td style={styles.td} colSpan={5}>
                Loading pricing…
              </td>
            </tr>
          ) : sortedRows.length === 0 ? (
            <tr>
              <td style={styles.td} colSpan={5}>
                No rate rows yet. Click <strong>Import OpenAI defaults</strong> below to seed the table.
              </td>
            </tr>
          ) : null}
          {sortedRows.map(([key, row]) => (
            <tr key={key}>
              <td style={styles.td}><code>{key}</code></td>
              <td style={styles.td}>
                <input
                  type="text"
                  value={row.display_name ?? ""}
                  placeholder={key}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      pricing: {
                        ...c.pricing,
                        [key]: { ...c.pricing[key], display_name: e.target.value || undefined },
                      },
                    }))
                  }
                  style={{ ...styles.input, minWidth: 180 }}
                />
              </td>
              <td style={styles.td}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.input}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      pricing: {
                        ...c.pricing,
                        [key]: { ...c.pricing[key], input: Number(e.target.value) || 0 },
                      },
                    }))
                  }
                  style={{ ...styles.input, width: 120 }}
                />
              </td>
              <td style={styles.td}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={row.output}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      pricing: {
                        ...c.pricing,
                        [key]: { ...c.pricing[key], output: Number(e.target.value) || 0 },
                      },
                    }))
                  }
                  style={{ ...styles.input, width: 120 }}
                />
              </td>
              <td style={styles.td}>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={() =>
                    setConfig((c) => {
                      const next = { ...c.pricing };
                      delete next[key];
                      return { ...c, pricing: next };
                    })
                  }
                  aria-label={`Delete rate for ${key}`}
                >×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        data-add-rate
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const key = String(fd.get("key") ?? "").trim();
          const input = Number(fd.get("input") ?? 0);
          const output = Number(fd.get("output") ?? 0);
          const display_name = String(fd.get("display_name") ?? "").trim() || undefined;
          if (!key) return;
          setConfig((c) => ({
            ...c,
            pricing: { ...c.pricing, [key]: { input, output, display_name } },
          }));
          (e.currentTarget as HTMLFormElement).reset();
        }}
        style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <input name="key" placeholder="model id (e.g. gpt-5.6)" required style={{ ...styles.input, minWidth: 240 }} />
        <input name="display_name" placeholder="display name (optional)" style={{ ...styles.input, minWidth: 200 }} />
        <input name="input" type="number" step="0.01" min="0" placeholder="input $/MTok" required style={{ ...styles.input, width: 140 }} />
        <input name="output" type="number" step="0.01" min="0" placeholder="output $/MTok" required style={{ ...styles.input, width: 140 }} />
        <button type="submit" style={styles.btn}>Add rate</button>
        <button
          type="button"
          style={styles.btn}
          title="Merge OpenAI's published list-price defaults into the table. Operator-set rows are kept; missing rows are filled in. Click Save to persist."
          onClick={() => {
            setConfig((c) => ({
              ...c,
              pricing: {
                ...DEFAULT_SEED_PRICING.pricing,
                ...c.pricing,
              },
            }));
          }}
        >Import OpenAI defaults</button>
      </form>

      <div style={{ marginTop: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 13 }} htmlFor="effective-input-rate-multiplier">
            Effective input rate multiplier
          </label>
          <input
            id="effective-input-rate-multiplier"
            type="number"
            step="0.01"
            min="0.01"
            max="1"
            defaultValue={config.effective_input_rate_multiplier ?? 1}
            key={`mult-${config.effective_input_rate_multiplier ?? 1}`}
            onBlur={(e) => {
              const n = parseFloat(e.target.value);
              const next =
                Number.isFinite(n) && n > 0 && n <= 1
                  ? n
                  : (config.effective_input_rate_multiplier ?? 1);
              if (Number.isFinite(n) && (n <= 0 || n > 1)) {
                e.target.value = String(next);
              }
              setConfig((c) => ({
                ...c,
                effective_input_rate_multiplier: next,
              }));
            }}
            style={{ ...styles.input, width: 140 }}
          />
          <span style={{ fontSize: 12, color: "var(--tu-muted, #666)" }}>
            Default 1.0 = full list price. Most useful for tuning the effective input
            rate against your cache-hit ratio (OpenAI cached input is ~10% of standard).
          </span>
        </div>
      </div>

      {/* Billing currency + FX status */}
      <div
        style={{
          marginTop: 24,
          padding: 16,
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "var(--card)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h3 style={{ ...styles.sectionTitle, margin: 0 }}>Billing currency</h3>
            <p style={{ fontSize: 12, color: "var(--muted-foreground)", margin: "4px 0 0" }}>
              Per-1M rates are in USD. Choose what currency the client sees;
              the worker fetches a daily USD→target rate from{" "}
              <code>open.er-api.com</code> and stores one row per day per
              currency in <code>fx_rates</code>. Conversion happens at query
              time so changing currency or margin later doesn't require a
              resnapshot.
            </p>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 13, color: "var(--foreground)" }} htmlFor="ctu-currency-select">
            Currency
          </label>
          <select
            id="ctu-currency-select"
            style={{ ...styles.input, minWidth: 140 }}
            value={currencyConfig.data?.currency ?? "USD"}
            disabled={savingCurrency || currencyConfig.loading}
            onChange={(e) => onCurrencyChange(e.target.value as CurrencyCode)}
          >
            {(currencyConfig.data?.supported ?? UI_CURRENCIES).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            style={styles.btn}
            onClick={onRefreshFx}
            disabled={refreshingFx}
            title="Force-refresh today's FX rate now instead of waiting for the hourly job"
          >
            {refreshingFx ? "Refreshing…" : "Refresh FX now"}
          </button>
        </div>

        <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted-foreground)", fontVariantNumeric: "tabular-nums" }}>
          {fxStatus.loading ? (
            "Loading FX status…"
          ) : !fxStatus.data ? (
            "No FX status available."
          ) : fxStatus.data.identity ? (
            <>USD is the base currency — no conversion is applied.</>
          ) : fxStatus.data.rate === null ? (
            <>
              No FX rate stored yet for {fxStatus.data.currency}. Click{" "}
              <em>Refresh FX now</em> to fetch one.
            </>
          ) : (
            <>
              1 USD = {fxStatus.data.rate?.toFixed(4)} {fxStatus.data.currency}{" "}
              (as of {fxStatus.data.rateDay ?? "?"} via{" "}
              {fxStatus.data.rateSource ?? fxStatus.data.provider})
            </>
          )}
        </div>
      </div>

      <div style={{ marginTop: 20, display: "flex", gap: 12, alignItems: "center" }}>
        <label style={{ fontSize: 13, color: "var(--tu-fg)" }}>Margin %</label>
        <input
          type="number"
          step="0.1"
          min="0"
          value={config.margin.percent}
          onChange={(e) =>
            setConfig((c) => ({
              ...c,
              margin: { percent: Number(e.target.value) || 0 },
            }))
          }
          style={{ ...styles.input, width: 120 }}
        />
      </div>

      <div style={{ marginTop: 24, display: "flex", alignItems: "center", gap: 12 }}>
        <button
          style={styles.btnPrimary}
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <span style={{ fontSize: 12, color: "var(--tu-muted, #888)" }}>
          Saving applies this pricing to every event in this company —
          past and future.
        </span>
      </div>
      {saveError && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderLeft: "3px solid #ef4444",
            background: "rgba(239, 68, 68, 0.08)",
            borderRadius: 4,
            fontSize: 13,
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          <strong>Save failed.</strong> {saveError}
        </div>
      )}
      <HistoryPanel companyId={companyId} />
    </div>
  );
}

export default UsagePage;

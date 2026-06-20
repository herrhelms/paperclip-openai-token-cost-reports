import { describe, it, expect } from "vitest";
import manifest from "../src/manifest";
import {
  csvCell,
  isIsoDate,
  isPlausibleFxRate,
  isPricingConfig,
  normalizeModel,
  PRICED_MODEL_KEYS,
  priceFor,
  slugifyForFilename,
  upgradePricingConfig,
  type ModelKey,
  type PricingConfig,
} from "../src/worker";

// These tests cover the pure functions that carry the load-bearing math and
// shape decisions: pricing, normalization, model recognition, and slug rules.
// End-to-end behavior is verified via the worker bridge from the host CLI in
// CI; this file targets logic that doesn't require a worker harness.

// ---- Manifest sanity ------------------------------------------------------

describe("manifest", () => {
  it("declares apiVersion 1", () => {
    expect(manifest.apiVersion).toBe(1);
  });

  it("uses the expected slug", () => {
    expect(manifest.id).toMatch(/openai-token-cost-reports/);
  });

  it("declares the page slot with routePath 'monthly-report-openai'", () => {
    const slots = (manifest.ui?.slots ?? []) as Array<{
      type: string;
      routePath?: string;
    }>;
    const page = slots.find((s) => s.type === "page");
    expect(page).toBeTruthy();
    expect(page?.routePath).toBe("monthly-report-openai");
  });

  it("declares a settingsPage slot without routePath", () => {
    const slots = (manifest.ui?.slots ?? []) as Array<{
      type: string;
      routePath?: string;
    }>;
    const settings = slots.find((s) => s.type === "settingsPage");
    expect(settings).toBeTruthy();
    expect(settings?.routePath).toBeUndefined();
  });

  it("routePath is a single-segment lowercase slug", () => {
    const slots = (manifest.ui?.slots ?? []) as Array<{
      type: string;
      routePath?: string;
    }>;
    const page = slots.find((s) => s.type === "page");
    expect(page?.routePath).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(page?.routePath).not.toMatch(/\//);
  });

  it("declares all capabilities the worker actually exercises", () => {
    const caps = manifest.capabilities ?? [];
    for (const required of [
      "events.subscribe",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "api.routes.register",
      "ui.page.register",
      "plugin.state.read",
      "plugin.state.write",
      "jobs.schedule",
      "instance.settings.register",
      "costs.read",
      "agents.read",
      "http.outbound",
      "companies.read",
    ]) {
      expect(caps).toContain(required);
    }
  });

  it("registers the daily rollup and FX fetcher jobs", () => {
    const jobs = (manifest.jobs ?? []) as Array<{ jobKey: string; schedule: string }>;
    expect(jobs.map((j) => j.jobKey)).toEqual(
      expect.arrayContaining(["rollup-daily", "fetch-fx-daily"]),
    );
  });

  it("registers cost_events as the only core-read table", () => {
    expect(manifest.database?.coreReadTables ?? []).toEqual(["cost_events"]);
  });
});

// ---- Model normalization --------------------------------------------------

describe("normalizeModel", () => {
  it("returns 'unknown' for non-strings", () => {
    expect(normalizeModel(undefined)).toBe("unknown");
    expect(normalizeModel(null)).toBe("unknown");
    expect(normalizeModel(42)).toBe("unknown");
  });

  it("preserves canonical priced keys verbatim", () => {
    for (const k of PRICED_MODEL_KEYS) {
      expect(normalizeModel(k)).toBe(k);
    }
  });

  it("recognizes flagship GPT-5.5 with dotted minor version", () => {
    expect(normalizeModel("gpt-5.5")).toBe("gpt-5-5");
    expect(normalizeModel("gpt-5.5-pro")).toBe("gpt-5-5-pro");
  });

  it("recognizes GPT-5.4 family with size suffixes", () => {
    expect(normalizeModel("gpt-5.4")).toBe("gpt-5-4");
    expect(normalizeModel("gpt-5.4-mini")).toBe("gpt-5-4-mini");
    expect(normalizeModel("gpt-5.4-nano")).toBe("gpt-5-4-nano");
  });

  it("recognizes the GPT-5.3 codex specialty model", () => {
    expect(normalizeModel("gpt-5.3-codex")).toBe("gpt-5-3-codex");
    expect(normalizeModel("gpt-5_3_codex")).toBe("gpt-5-3-codex");
  });

  it("accepts versioned snapshot ids", () => {
    expect(normalizeModel("gpt-5.5-2026-01-15")).toBe("gpt-5-5");
    expect(normalizeModel("gpt-5.4-mini-2025-12-08")).toBe("gpt-5-4-mini");
  });

  it("recognizes o-series reasoning + specialty models", () => {
    expect(normalizeModel("o4-mini")).toBe("o4-mini");
    expect(normalizeModel("o4-mini-deep-research")).toBe("o4-mini-deep-research");
    expect(normalizeModel("o3-deep-research")).toBe("o3-deep-research");
    expect(normalizeModel("chat-latest")).toBe("chat-latest");
    expect(normalizeModel("computer-use-preview")).toBe("computer-use-preview");
    expect(normalizeModel("gpt-5.4-pro")).toBe("gpt-5-4-pro");
  });

  it("strips ISO-date snapshot suffix to match generic key", () => {
    expect(normalizeModel("o4-mini-2025-04-16")).toBe("o4-mini");
    expect(normalizeModel("o3-deep-research-2026-01-15")).toBe("o3-deep-research");
  });

  it("returns 'unknown' for unrelated families", () => {
    expect(normalizeModel("claude-opus-4-7")).toBe("unknown");
    expect(normalizeModel("gemini-2.0-pro")).toBe("unknown");
    expect(normalizeModel("gpt-4o")).toBe("unknown");
  });
});

// ---- Pricing math ---------------------------------------------------------

const FULL_PRICING: PricingConfig = {
  pricing: {
    "gpt-5-5":               { input: 5, output: 30 },
    "gpt-5-5-pro":           { input: 30, output: 180 },
    "gpt-5-4":               { input: 2.5, output: 15 },
    "gpt-5-4-mini":          { input: 0.75, output: 4.5 },
    "gpt-5-4-nano":          { input: 0.2, output: 1.25 },
    "gpt-5-4-pro":           { input: 30, output: 180 },
    "gpt-5-3-codex":         { input: 1.75, output: 14 },
    "chat-latest":           { input: 5, output: 30 },
    "computer-use-preview":  { input: 1.5, output: 6 },
    "o3-deep-research":      { input: 5, output: 20 },
    "o4-mini-deep-research": { input: 1, output: 4 },
    "o4-mini":               { input: 4, output: 16 },
  },
  margin: { percent: 0 },
};

describe("priceFor", () => {
  it("returns zero for 'unknown' model regardless of tokens", () => {
    const { inputCost, outputCost } = priceFor("unknown" as ModelKey, 1_000_000, 1_000_000, FULL_PRICING);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });

  it("computes cost as tokens / 1M × rate", () => {
    const { inputCost, outputCost } = priceFor("gpt-5-5", 2_000_000, 1_000_000, FULL_PRICING);
    expect(inputCost).toBeCloseTo(10, 8); // 2M × $5 = $10
    expect(outputCost).toBeCloseTo(30, 8); // 1M × $30 = $30
  });

  it("returns zero when a model is missing from the rate table", () => {
    const sparse = { ...FULL_PRICING, pricing: { ...FULL_PRICING.pricing } } as PricingConfig;
    delete (sparse.pricing as Record<string, unknown>)["gpt-5-5"];
    const { inputCost, outputCost } = priceFor("gpt-5-5", 1_000_000, 1_000_000, sparse);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });
});

describe("isPricingConfig", () => {
  it("accepts the canonical PricingConfig shape", () => {
    expect(isPricingConfig(FULL_PRICING)).toBe(true);
  });

  it("rejects partial pricing tables", () => {
    const partial = { ...FULL_PRICING, pricing: { "gpt-5-5": { input: 5, output: 30 } } };
    expect(isPricingConfig(partial)).toBe(false);
  });

  it("rejects missing margin", () => {
    const noMargin = { ...FULL_PRICING } as Partial<PricingConfig>;
    delete noMargin.margin;
    expect(isPricingConfig(noMargin)).toBe(false);
  });
});

describe("upgradePricingConfig", () => {
  it("returns a copy of DEFAULT_PRICING for arbitrary garbage", () => {
    const out = upgradePricingConfig({ random: "garbage" });
    expect(out.pricing["gpt-5-5"]).toBeDefined();
    expect(out.margin.percent).toBe(0);
  });

  it("ignores a legacy subscription field on input configs", () => {
    const upgraded = upgradePricingConfig({
      pricing: FULL_PRICING.pricing,
      margin: { percent: 10 },
      subscription: { preset: "max", divisor: 20 },
    });
    expect(upgraded.margin.percent).toBe(10);
    expect((upgraded as unknown as Record<string, unknown>).subscription).toBeUndefined();
  });
});

// ---- Filename slugger -----------------------------------------------------

describe("slugifyForFilename", () => {
  it("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(slugifyForFilename("Alarm-Direct Social")).toBe("alarm-direct-social");
    expect(slugifyForFilename("Acme & Co.")).toBe("acme-co");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugifyForFilename("  ¡¡Hello!! ")).toBe("hello");
  });

  it("collapses repeated separators", () => {
    expect(slugifyForFilename("foo___bar...baz   qux")).toBe("foo-bar-baz-qux");
  });

  it("caps the result at 40 chars", () => {
    const long = "a".repeat(80);
    expect(slugifyForFilename(long)).toHaveLength(40);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugifyForFilename("////")).toBe("");
    expect(slugifyForFilename("")).toBe("");
  });
});

describe("isIsoDate", () => {
  it("accepts canonical YYYY-MM-DD", () => {
    expect(isIsoDate("2026-06-20")).toBe(true);
    expect(isIsoDate("2000-01-01")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20260620)).toBe(false);
  });

  it("rejects shapes that aren't YYYY-MM-DD", () => {
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate("2026/06/20")).toBe(false);
    expect(isIsoDate("26-06-20")).toBe(false);
    expect(isIsoDate("2026-6-20")).toBe(false);
  });

  it("rejects values containing quotes or CRLF (header-injection vector)", () => {
    expect(isIsoDate('2026-06-20"')).toBe(false);
    expect(isIsoDate("2026-06-20\r\nX-Foo: bar")).toBe(false);
    expect(isIsoDate("2026-06-20\nA")).toBe(false);
  });
});

describe("csvCell", () => {
  it("returns values unchanged when they contain no special chars", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
    expect(csvCell("EUR")).toBe("EUR");
  });

  it("quotes and escapes when value contains a comma", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles internal quotes", () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("quotes when value contains CR or LF", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\rline2")).toBe('"line1\rline2"');
  });
});

describe("isPlausibleFxRate", () => {
  it("accepts realistic rates", () => {
    expect(isPlausibleFxRate(0.92)).toBe(true);
    expect(isPlausibleFxRate(0.79)).toBe(true);
    expect(isPlausibleFxRate(157.4)).toBe(true);
  });

  it("rejects rates that are zero, negative, or NaN", () => {
    expect(isPlausibleFxRate(0)).toBe(false);
    expect(isPlausibleFxRate(-1.2)).toBe(false);
    expect(isPlausibleFxRate(NaN)).toBe(false);
    expect(isPlausibleFxRate(Infinity)).toBe(false);
    expect(isPlausibleFxRate(-Infinity)).toBe(false);
  });

  it("rejects rates outside the sanity envelope", () => {
    expect(isPlausibleFxRate(0.001)).toBe(false);
    expect(isPlausibleFxRate(10_000)).toBe(false);
    expect(isPlausibleFxRate(1_000_000)).toBe(false);
  });

  it("rejects non-numbers", () => {
    expect(isPlausibleFxRate("0.92")).toBe(false);
    expect(isPlausibleFxRate(undefined)).toBe(false);
    expect(isPlausibleFxRate(null)).toBe(false);
  });
});

describe("isPricingConfig margin bounds", () => {
  const buildConfig = (marginPercent: unknown): unknown => ({
    pricing: Object.fromEntries(
      PRICED_MODEL_KEYS.map((k) => [k, { input: 1, output: 2 }]),
    ),
    margin: { percent: marginPercent },
  });

  it("accepts margin.percent of 0", () => {
    expect(isPricingConfig(buildConfig(0))).toBe(true);
  });

  it("accepts margin.percent of 500 (boundary)", () => {
    expect(isPricingConfig(buildConfig(500))).toBe(true);
  });

  it("rejects margin.percent of NaN", () => {
    expect(isPricingConfig(buildConfig(NaN))).toBe(false);
  });

  it("rejects negative margin.percent", () => {
    expect(isPricingConfig(buildConfig(-1))).toBe(false);
    expect(isPricingConfig(buildConfig(-50))).toBe(false);
  });

  it("rejects margin.percent above the 500 cap", () => {
    expect(isPricingConfig(buildConfig(501))).toBe(false);
    expect(isPricingConfig(buildConfig(1000))).toBe(false);
    expect(isPricingConfig(buildConfig(1e308))).toBe(false);
  });

  it("rejects Infinity margin.percent", () => {
    expect(isPricingConfig(buildConfig(Infinity))).toBe(false);
    expect(isPricingConfig(buildConfig(-Infinity))).toBe(false);
  });
});

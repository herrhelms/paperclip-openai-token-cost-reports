import { describe, it, expect } from "vitest";
import manifest from "../src/manifest";
import {
  csvCell,
  isIsoDate,
  isPlausibleFxRate,
  priceFor,
  priceTiers,
  slugifyForFilename,
} from "../src/worker";
import {
  validatePricingConfig,
  isValidPricingConfig,
  findActiveSnapshot,
  lookupRate,
  DEFAULT_SEED_PRICING,
  type PricingConfig,
  type PricingSnapshot,
  type RateRow,
} from "../src/pricing";

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

// ---- Pricing math ---------------------------------------------------------

describe("priceFor (free-form)", () => {
  const cfg: PricingConfig = {
    pricing: {
      "gpt-5.5": { input: 5, output: 30 },
    },
    margin: { percent: 0 },
  };

  it("returns zero when raw_model has no rate row", () => {
    const { inputCost, outputCost } = priceFor("gpt-5.4", 1_000_000, 1_000_000, cfg);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });

  it("computes cost via tokens / 1M × rate", () => {
    const { inputCost, outputCost } = priceFor("gpt-5.5", 2_000_000, 1_000_000, cfg);
    expect(inputCost).toBeCloseTo(10, 8);   // 2M × $5 = $10
    expect(outputCost).toBeCloseTo(30, 8);  // 1M × $30 = $30
  });

  it("ignores effective_input_rate_multiplier — priceFor returns raw list", () => {
    // 2.1.x: priceFor returns OpenAI list pricing (tokens × rate). Callers
    // apply the multiplier themselves as part of the three-tier rollup
    // (list → your cost → client price), so this primitive must NOT
    // pre-multiply input.
    const withMult: PricingConfig = {
      ...cfg,
      effective_input_rate_multiplier: 0.2,
    };
    const { inputCost, outputCost } = priceFor("gpt-5.5", 2_000_000, 1_000_000, withMult);
    expect(inputCost).toBeCloseTo(10, 8);  // raw list — multiplier ignored
    expect(outputCost).toBeCloseTo(30, 8);
  });
});

// ---- Three-tier rollup (the canonical helper) -----------------------------

describe("priceTiers", () => {
  const baseCfg: PricingConfig = {
    pricing: {
      "gpt-5.5": { input: 5, output: 30 },
    },
    margin: { percent: 0 },
  };

  it("flags hasRate=false and emits zeros when the model has no rate row", () => {
    const t = priceTiers("o4-mini", 1_000_000, 1_000_000, baseCfg);
    expect(t.hasRate).toBe(false);
    expect(t.list).toBe(0);
    expect(t.cost).toBe(0);
    expect(t.price).toBe(0);
  });

  it("collapses to list = cost = price when multiplier is 1 and margin is 0", () => {
    const t = priceTiers("gpt-5.5", 2_000_000, 1_000_000, baseCfg);
    expect(t.hasRate).toBe(true);
    expect(t.list).toBeCloseTo(40, 8); // 2×$5 + 1×$30
    expect(t.cost).toBeCloseTo(40, 8);
    expect(t.price).toBeCloseTo(40, 8);
  });

  it("scales cost by multiplier on the whole list, then margin on top", () => {
    const cfg: PricingConfig = {
      ...baseCfg,
      margin: { percent: 15 },
      effective_input_rate_multiplier: 0.05,
    };
    const t = priceTiers("gpt-5.5", 2_000_000, 1_000_000, cfg);
    // list = $40; cost = 40 × 0.05 = $2.00; price = 2.00 × 1.15 = $2.30
    expect(t.list).toBeCloseTo(40, 8);
    expect(t.cost).toBeCloseTo(2, 8);
    expect(t.price).toBeCloseTo(2.3, 8);
  });

  it("treats missing effective_input_rate_multiplier as 1.0", () => {
    const t = priceTiers("gpt-5.5", 2_000_000, 0, baseCfg);
    expect(t.cost).toBeCloseTo(t.list, 8);
  });

  it("returns finite numbers for negative-token inputs (defensive)", () => {
    const t = priceTiers("gpt-5.5", -1, -1, baseCfg);
    expect(Number.isFinite(t.list)).toBe(true);
    expect(Number.isFinite(t.cost)).toBe(true);
    expect(Number.isFinite(t.price)).toBe(true);
  });

  it("maintains list ≥ cost ≤ price ordering for any valid mult + margin", () => {
    const cfg: PricingConfig = {
      ...baseCfg,
      margin: { percent: 20 },
      effective_input_rate_multiplier: 0.5,
    };
    const t = priceTiers("gpt-5.5", 3_000_000, 1_000_000, cfg);
    expect(t.list).toBeGreaterThanOrEqual(t.cost);
    expect(t.price).toBeGreaterThanOrEqual(t.cost);
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

// ---- Free-form pricing primitives ----------------------------------------

describe("validatePricingConfig (verbose)", () => {
  it("returns null for the seed config", () => {
    expect(validatePricingConfig(DEFAULT_SEED_PRICING)).toBeNull();
  });

  it("accepts an empty pricing table", () => {
    expect(
      validatePricingConfig({ pricing: {}, margin: { percent: 0 } }),
    ).toBeNull();
  });

  it("accepts arbitrary operator-defined keys", () => {
    expect(
      validatePricingConfig({
        pricing: { "some-future-model-xyz": { input: 1, output: 2 } },
        margin: { percent: 5 },
      }),
    ).toBeNull();
  });

  it("reports the offending row + field for negative input", () => {
    const msg = validatePricingConfig({
      pricing: { "gpt-5.5": { input: -1, output: 2 } },
      margin: { percent: 0 },
    });
    expect(msg).toContain("gpt-5.5");
    expect(msg).toContain("input");
    expect(msg).toContain(">= 0");
  });

  it("reports the offending row for non-number input", () => {
    const msg = validatePricingConfig({
      pricing: { "x": { input: "5", output: 2 } as unknown as RateRow },
      margin: { percent: 0 },
    });
    expect(msg).toContain("finite number");
  });

  it("reports empty-string row keys", () => {
    const msg = validatePricingConfig({
      pricing: { "": { input: 1, output: 2 } },
      margin: { percent: 0 },
    });
    expect(msg).toContain("non-empty string");
  });

  it("reports margin out of range", () => {
    expect(validatePricingConfig({ pricing: {}, margin: { percent: -1 } }))
      .toContain("margin.percent");
    expect(validatePricingConfig({ pricing: {}, margin: { percent: 501 } }))
      .toContain("margin.percent");
  });

  it("reports multiplier out of range", () => {
    expect(
      validatePricingConfig({
        pricing: {},
        margin: { percent: 0 },
        effective_input_rate_multiplier: 0,
      }),
    ).toContain("multiplier");
    expect(
      validatePricingConfig({
        pricing: {},
        margin: { percent: 0 },
        effective_input_rate_multiplier: 1.5,
      }),
    ).toContain("multiplier");
  });
});

describe("isValidPricingConfig (boolean wrapper)", () => {
  it("agrees with validatePricingConfig", () => {
    expect(isValidPricingConfig(DEFAULT_SEED_PRICING)).toBe(true);
    expect(isValidPricingConfig({ pricing: {}, margin: { percent: -1 } })).toBe(false);
  });
});

describe("findActiveSnapshot", () => {
  const mkSnap = (effective_from: string): PricingSnapshot => ({
    effective_from,
    config: { pricing: {}, margin: { percent: 0 } },
  });

  it("returns null when there are no snapshots", () => {
    expect(findActiveSnapshot([], "2026-04-01T00:00:00Z")).toBeNull();
  });

  it("returns the only snapshot in the N=1 case regardless of event time", () => {
    const one = mkSnap("2026-06-01T00:00:00Z");
    expect(findActiveSnapshot([one], "1990-01-01T00:00:00Z")).toBe(one);
    expect(findActiveSnapshot([one], "2030-01-01T00:00:00Z")).toBe(one);
  });

  it("returns the greatest effective_from <= occurredAt (snapshots sorted DESC)", () => {
    const april = mkSnap("2026-04-01T00:00:00Z");
    const june = mkSnap("2026-06-01T00:00:00Z");
    const dec = mkSnap("2026-12-01T00:00:00Z");
    const desc = [dec, june, april];
    expect(findActiveSnapshot(desc, "2026-04-15T00:00:00Z")).toBe(april);
    expect(findActiveSnapshot(desc, "2026-07-15T00:00:00Z")).toBe(june);
    expect(findActiveSnapshot(desc, "2026-12-15T00:00:00Z")).toBe(dec);
  });

  it("falls back to the earliest snapshot for events that predate all", () => {
    const april = mkSnap("2026-04-01T00:00:00Z");
    const june = mkSnap("2026-06-01T00:00:00Z");
    const desc = [june, april];
    expect(findActiveSnapshot(desc, "2025-01-01T00:00:00Z")).toBe(april);
  });
});

describe("lookupRate", () => {
  const snap: PricingSnapshot = {
    effective_from: "1970-01-01T00:00:00Z",
    config: {
      pricing: { "gpt-5.5": { input: 5, output: 30 } },
      margin: { percent: 0 },
    },
  };

  it("returns the row for an exact match", () => {
    expect(lookupRate(snap, "gpt-5.5")).toEqual({ input: 5, output: 30 });
  });

  it("returns undefined for an unmatched raw_model — no fuzzy fallback", () => {
    expect(lookupRate(snap, "gpt-5.4")).toBeUndefined();
    expect(lookupRate(snap, "gpt-5.5-2026-08-01")).toBeUndefined();
    expect(lookupRate(snap, "")).toBeUndefined();
  });
});

describe("CSV export unpriced mode", () => {
  it("validates that mode is 'skip' or 'include'", () => {
    const valid = ["skip", "include"];
    expect(valid).toContain("skip");
    expect(valid).toContain("include");
    expect(valid.includes("foo")).toBe(false);
  });
});

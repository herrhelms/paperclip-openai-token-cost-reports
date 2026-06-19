import { describe, it, expect } from "vitest";
import manifest from "../src/manifest";
import {
  isPricingConfig,
  normalizeModel,
  PRICED_MODEL_KEYS,
  priceFor,
  slugifyForFilename,
  subscriptionDivisor,
  SUBSCRIPTION_DIVISORS,
  upgradePricingConfig,
  type ModelKey,
  type PricingConfig,
} from "../src/worker";

// These tests cover the pure functions that carry the load-bearing math and
// shape decisions: pricing, normalization, model recognition, slug rules, and
// the subscription divisor. End-to-end behavior is verified via the worker
// bridge from the host CLI in CI; this file targets logic that doesn't
// require a worker harness.

// ---- Manifest sanity ------------------------------------------------------

describe("manifest", () => {
  it("declares apiVersion 1", () => {
    expect(manifest.apiVersion).toBe(1);
  });

  it("uses the expected slug", () => {
    expect(manifest.id).toMatch(/claude-token-cost-reports/);
  });

  it("declares the page slot with routePath 'tokens'", () => {
    const slots = (manifest.ui?.slots ?? []) as Array<{
      type: string;
      routePath?: string;
    }>;
    const page = slots.find((s) => s.type === "page");
    expect(page).toBeTruthy();
    expect(page?.routePath).toBe("tokens");
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

  it("remaps legacy bare-family keys to the most recent variant", () => {
    expect(normalizeModel("opus")).toBe("opus-4-7");
    expect(normalizeModel("sonnet")).toBe("sonnet-4-6");
  });

  it("derives version from common dot/dash/underscore-separated families", () => {
    expect(normalizeModel("claude-opus-4-8-20260101")).toBe("opus-4-8");
    expect(normalizeModel("Claude.Sonnet.4.6")).toBe("sonnet-4-6");
    expect(normalizeModel("opus_4_7")).toBe("opus-4-7");
  });

  it("detects the [1m] long-context marker", () => {
    expect(normalizeModel("claude-opus-4-8[1m]")).toBe("opus-4-8-1m");
    expect(normalizeModel("Opus 4.8 1m")).toBe("opus-4-8-1m");
    expect(normalizeModel("sonnet-4-6-1m")).toBe("sonnet-4-6-1m");
  });

  it("falls back to 'unknown' for models with no recognizable family", () => {
    expect(normalizeModel("haiku-4-0")).toBe("unknown");
    expect(normalizeModel("claude-instant")).toBe("unknown");
  });
});

// ---- Pricing math ---------------------------------------------------------

const FULL_PRICING: PricingConfig = {
  pricing: {
    "opus-4-8": { input: 5, output: 25 },
    "opus-4-8-1m": { input: 5, output: 25 },
    "opus-4-7": { input: 5, output: 25 },
    "opus-4-7-1m": { input: 5, output: 25 },
    "sonnet-4-6": { input: 3, output: 15 },
    "sonnet-4-6-1m": { input: 3, output: 15 },
    "sonnet-4-5": { input: 3, output: 15 },
    "sonnet-4-5-1m": { input: 3, output: 15 },
  },
  margin: { percent: 0 },
  subscription: { preset: "off", divisor: 1 },
};

describe("priceFor", () => {
  it("returns zero for 'unknown' model regardless of tokens", () => {
    const { inputCost, outputCost } = priceFor("unknown" as ModelKey, 1_000_000, 1_000_000, FULL_PRICING);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });

  it("computes cost as tokens / 1M × rate", () => {
    const { inputCost, outputCost } = priceFor("opus-4-8", 2_000_000, 1_000_000, FULL_PRICING);
    expect(inputCost).toBeCloseTo(10, 8); // 2M × $5 = $10
    expect(outputCost).toBeCloseTo(25, 8); // 1M × $25 = $25
  });

  it("returns zero when a model is missing from the rate table", () => {
    const sparse = { ...FULL_PRICING, pricing: { ...FULL_PRICING.pricing } } as PricingConfig;
    delete (sparse.pricing as Record<string, unknown>)["opus-4-8"];
    const { inputCost, outputCost } = priceFor("opus-4-8", 1_000_000, 1_000_000, sparse);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });
});

describe("subscriptionDivisor", () => {
  it("defaults to 1 when pricing or subscription is absent", () => {
    expect(subscriptionDivisor(null)).toBe(1);
    expect(subscriptionDivisor(undefined)).toBe(1);
    expect(subscriptionDivisor({ ...FULL_PRICING, subscription: undefined })).toBe(1);
  });

  it("returns 1 for 'off' even if divisor is set non-1", () => {
    const cfg: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "off", divisor: 99 },
    };
    expect(subscriptionDivisor(cfg)).toBe(1);
  });

  it("returns the per-preset divisor for pro and max", () => {
    const pro: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "pro", divisor: SUBSCRIPTION_DIVISORS.pro },
    };
    const max: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "max", divisor: SUBSCRIPTION_DIVISORS.max },
    };
    expect(subscriptionDivisor(pro)).toBe(5);
    expect(subscriptionDivisor(max)).toBe(20);
  });

  it("falls back to 1 when divisor is non-finite or non-positive", () => {
    const broken: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "max", divisor: -1 },
    };
    expect(subscriptionDivisor(broken)).toBe(1);
  });
});

describe("isPricingConfig", () => {
  it("accepts the canonical PricingConfig shape", () => {
    expect(isPricingConfig(FULL_PRICING)).toBe(true);
  });

  it("rejects partial pricing tables", () => {
    const partial = { ...FULL_PRICING, pricing: { "opus-4-8": { input: 5, output: 25 } } };
    expect(isPricingConfig(partial)).toBe(false);
  });

  it("rejects missing margin", () => {
    const noMargin = { ...FULL_PRICING } as Partial<PricingConfig>;
    delete noMargin.margin;
    expect(isPricingConfig(noMargin)).toBe(false);
  });

  it("tolerates missing subscription (legacy pre-0.7.0 configs)", () => {
    const noSub = { ...FULL_PRICING } as PricingConfig;
    delete noSub.subscription;
    expect(isPricingConfig(noSub)).toBe(true);
  });
});

describe("upgradePricingConfig", () => {
  it("returns a copy of DEFAULT_PRICING for arbitrary garbage", () => {
    const out = upgradePricingConfig({ random: "garbage" });
    expect(out.pricing["opus-4-8"]).toEqual({ input: 5, output: 25 });
    expect(out.margin).toEqual({ percent: 0 });
  });

  it("carries forward legacy bare opus/sonnet keys to the most recent variant", () => {
    const legacy = {
      pricing: {
        opus: { input: 8, output: 40 },
        sonnet: { input: 4, output: 20 },
      },
      margin: { percent: 12 },
    };
    const out = upgradePricingConfig(legacy);
    expect(out.pricing["opus-4-7"]).toEqual({ input: 8, output: 40 });
    expect(out.pricing["sonnet-4-6"]).toEqual({ input: 4, output: 20 });
    expect(out.margin.percent).toBe(12);
  });

  it("does not clobber explicitly-set new keys with legacy ones", () => {
    const mixed = {
      pricing: {
        opus: { input: 99, output: 99 },
        "opus-4-7": { input: 7, output: 35 },
      },
      margin: { percent: 0 },
    };
    const out = upgradePricingConfig(mixed);
    // opus-4-7 was explicitly set, so the legacy `opus` mapping is ignored.
    expect(out.pricing["opus-4-7"]).toEqual({ input: 7, output: 35 });
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

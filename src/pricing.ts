// src/pricing.ts
//
// Pure pricing primitives — no SDK imports, no DB access, no I/O.
// Worker handlers compose these with ctx.db queries; tests import them
// directly. Type-level break from the 1.x ModelKey union: `model` is
// just `string` and `pricing` is keyed by any operator-supplied string.

export interface RateRow {
  input: number;          // USD per 1M input tokens
  output: number;         // USD per 1M output tokens
  display_name?: string;  // Optional UI label (e.g. "GPT-5.5"); falls back to the key
}

export interface PricingConfig {
  pricing: Record<string, RateRow>;
  margin: { percent: number };
  // Cost-adjustment knob. Default 1.0 = no adjustment. OpenAI doesn't
  // publish a per-token rate for flat-rate plans like Anthropic does, so
  // this is most useful for operators who want to tune the effective
  // input rate against a known cache-hit ratio (cached input on OpenAI
  // is ~10% of the standard rate) without rewriting every rate row.
  effective_input_rate_multiplier?: number;
}

export interface PricingSnapshot {
  effective_from: string;   // ISO 8601 UTC
  config: PricingConfig;
  created_at?: string;
  created_by?: string | null;
  note?: string | null;
}

// Verbose validator: returns the first error encountered as a human-
// readable string, or null when the config is valid. The worker uses
// this to throw precise errors for setPricing; isValidPricingConfig
// below is the type-guard wrapper for places that just need a boolean.
export function validatePricingConfig(v: unknown): string | null {
  if (!v || typeof v !== "object") {
    return "config must be an object";
  }
  const c = v as Record<string, unknown>;
  const p = c.pricing as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") {
    return "config.pricing must be an object (the rate-row table)";
  }
  for (const [key, row] of Object.entries(p)) {
    if (typeof key !== "string" || key.length === 0) {
      return `row key must be a non-empty string (got ${JSON.stringify(key)})`;
    }
    if (!row || typeof row !== "object") {
      return `row '${key}': value must be an object with input + output rates`;
    }
    const r = row as Record<string, unknown>;
    if (typeof r.input !== "number" || !Number.isFinite(r.input)) {
      return `row '${key}': input must be a finite number (got ${JSON.stringify(r.input)})`;
    }
    if (r.input < 0) {
      return `row '${key}': input must be >= 0 (got ${r.input})`;
    }
    if (typeof r.output !== "number" || !Number.isFinite(r.output)) {
      return `row '${key}': output must be a finite number (got ${JSON.stringify(r.output)})`;
    }
    if (r.output < 0) {
      return `row '${key}': output must be >= 0 (got ${r.output})`;
    }
    if (r.display_name !== undefined && typeof r.display_name !== "string") {
      return `row '${key}': display_name must be a string when present`;
    }
  }
  const margin = c.margin as Record<string, unknown> | undefined;
  if (!margin) {
    return "margin object is required (e.g. { percent: 5 })";
  }
  if (typeof margin.percent !== "number" || !Number.isFinite(margin.percent)) {
    return `margin.percent must be a finite number (got ${JSON.stringify(margin.percent)})`;
  }
  if (margin.percent < 0 || margin.percent > 500) {
    return `margin.percent must be in [0, 500] (got ${margin.percent})`;
  }
  const mult = c.effective_input_rate_multiplier;
  if (mult !== undefined) {
    if (typeof mult !== "number" || !Number.isFinite(mult)) {
      return `effective_input_rate_multiplier must be a finite number when present (got ${JSON.stringify(mult)})`;
    }
    if (mult <= 0 || mult > 1) {
      return `effective_input_rate_multiplier must be in (0, 1] (got ${mult})`;
    }
  }
  return null;
}

// Boolean type-guard. Internally delegates to validatePricingConfig.
export function isValidPricingConfig(v: unknown): v is PricingConfig {
  return validatePricingConfig(v) === null;
}

// Find the snapshot whose effective_from is the greatest <= occurredAt.
// Falls back to the earliest snapshot if the event predates all of them
// (operator's best-available rate for very old events). Returns null only
// when the snapshots array is empty.
export function findActiveSnapshot(
  snapshots: ReadonlyArray<PricingSnapshot>,
  occurredAt: string,
): PricingSnapshot | null {
  if (snapshots.length === 0) return null;
  // Snapshots arrive sorted DESC by effective_from (Task 3's loader does this).
  for (const s of snapshots) {
    if (s.effective_from <= occurredAt) return s;
  }
  return snapshots[snapshots.length - 1]; // earliest fallback
}

// Look up the rate for a raw_model in a snapshot's pricing table.
// Returns undefined when the model has no row — caller treats as unpriceable.
export function lookupRate(snapshot: PricingSnapshot, rawModel: string): RateRow | undefined {
  return snapshot.config.pricing[rawModel];
}

// Default seed pricing for a fresh install. Operators can edit/add/delete
// any row after install. Rates fetched from developers.openai.com/api/docs/pricing
// on 2026-06-20. Keys mirror the host's emitted strings (gpt-5.5 etc.) rather
// than the 1.x normalized form (gpt-5-5).
export const DEFAULT_SEED_PRICING: PricingConfig = {
  pricing: {
    "gpt-5.5":               { input: 5.00,  output: 30.00,  display_name: "GPT-5.5" },
    "gpt-5.5-pro":           { input: 30.00, output: 180.00, display_name: "GPT-5.5 Pro" },
    "gpt-5.4":               { input: 2.50,  output: 15.00,  display_name: "GPT-5.4" },
    "gpt-5.4-mini":          { input: 0.75,  output: 4.50,   display_name: "GPT-5.4 Mini" },
    "gpt-5.4-nano":          { input: 0.20,  output: 1.25,   display_name: "GPT-5.4 Nano" },
    "gpt-5.4-pro":           { input: 30.00, output: 180.00, display_name: "GPT-5.4 Pro" },
    "gpt-5.3-codex":         { input: 1.75,  output: 14.00,  display_name: "GPT-5.3 Codex" },
    "chat-latest":           { input: 5.00,  output: 30.00,  display_name: "ChatGPT (chat-latest)" },
    "computer-use-preview":  { input: 1.50,  output: 6.00,   display_name: "Computer Use Preview" },
    "o3-deep-research":      { input: 5.00,  output: 20.00,  display_name: "o3 Deep Research" },
    "o4-mini-deep-research": { input: 1.00,  output: 4.00,   display_name: "o4 Mini Deep Research" },
    "o4-mini":               { input: 4.00,  output: 16.00,  display_name: "o4 Mini" },
  },
  margin: { percent: 0 },
  effective_input_rate_multiplier: 1,
};

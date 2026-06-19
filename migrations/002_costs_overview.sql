-- 0.3.0 — capture richer cost_event.created fields so the plugin's usage page
-- can mirror the host /costs page (rolling windows, subscription split,
-- per-model breakdown). Idempotent: each ALTER is gated on column absence.

ALTER TABLE plugin_claude_token_cost_reports_c7ca204bbe.usage_events
  ADD COLUMN IF NOT EXISTS raw_model           TEXT,
  ADD COLUMN IF NOT EXISTS provider            TEXT,
  ADD COLUMN IF NOT EXISTS source              TEXT,
  ADD COLUMN IF NOT EXISTS cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_cents          INTEGER;

-- Backfill raw_model from the normalized model for legacy rows so the
-- per-model breakdown groups them consistently with new rows.
UPDATE plugin_claude_token_cost_reports_c7ca204bbe.usage_events
   SET raw_model = model
 WHERE raw_model IS NULL;

-- Default provider for legacy rows. Anthropic is the only provider this plugin
-- handles today; later providers can be added without backfilling further.
UPDATE plugin_claude_token_cost_reports_c7ca204bbe.usage_events
   SET provider = 'anthropic'
 WHERE provider IS NULL;

-- Index for time-window queries (rolling 5h / 24h / 7d aggregates).
CREATE INDEX IF NOT EXISTS usage_events_company_occurred_at_idx
  ON plugin_claude_token_cost_reports_c7ca204bbe.usage_events (company_id, occurred_at DESC);

-- Index for per-(raw_model, source) grouping.
CREATE INDEX IF NOT EXISTS usage_events_company_raw_model_idx
  ON plugin_claude_token_cost_reports_c7ca204bbe.usage_events (company_id, raw_model);

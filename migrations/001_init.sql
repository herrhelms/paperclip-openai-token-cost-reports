-- claude-token-cost-reports — initial schema.
-- The host runs this in the plugin's private namespace
-- `plugin_claude_token_cost_reports_c7ca204bbe`
-- (derived from `plugin_<slug>_<sha256(id)[0:10]>` for id `claude-token-cost-reports`).
-- All object refs must be fully qualified with that schema name.
--
-- Idempotent: each CREATE uses IF NOT EXISTS so the migration is safe to re-run
-- on a fresh install where the namespace registry was purged but the postgres
-- schema was left intact (purge --force on uninstall doesn't always DROP).

CREATE TABLE IF NOT EXISTS plugin_claude_token_cost_reports_c7ca204bbe.usage_events (
  source_event_id TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  agent_id        TEXT,
  model           TEXT NOT NULL,
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  occurred_at     TIMESTAMPTZ NOT NULL,
  day             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_events_company_day_idx
  ON plugin_claude_token_cost_reports_c7ca204bbe.usage_events (company_id, day);

CREATE INDEX IF NOT EXISTS usage_events_day_idx
  ON plugin_claude_token_cost_reports_c7ca204bbe.usage_events (day);

CREATE TABLE IF NOT EXISTS plugin_claude_token_cost_reports_c7ca204bbe.usage_daily (
  company_id     TEXT NOT NULL,
  day            TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   BIGINT NOT NULL DEFAULT 0,
  output_tokens  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, day, model)
);

CREATE INDEX IF NOT EXISTS usage_daily_company_idx
  ON plugin_claude_token_cost_reports_c7ca204bbe.usage_daily (company_id, day);

CREATE TABLE IF NOT EXISTS plugin_claude_token_cost_reports_c7ca204bbe.pricing_config (
  company_id TEXT PRIMARY KEY,
  json       TEXT NOT NULL
);

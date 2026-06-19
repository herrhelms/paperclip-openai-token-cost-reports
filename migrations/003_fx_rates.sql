-- claude-token-cost-reports — daily FX rates (USD -> target currency)
-- One row per (day, currency). Stored at fetch time; queried at render time so
-- changing margin or currency later doesn't require re-snapshotting history.
--
-- Idempotent: re-runnable on a fresh install where the namespace registry was
-- purged but the postgres schema carried forward.

CREATE TABLE IF NOT EXISTS plugin_claude_token_cost_reports_c7ca204bbe.fx_rates (
  day        TEXT NOT NULL,
  currency   TEXT NOT NULL,
  rate       NUMERIC(20, 10) NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, currency)
);

CREATE INDEX IF NOT EXISTS fx_rates_currency_day_idx
  ON plugin_claude_token_cost_reports_c7ca204bbe.fx_rates (currency, day DESC);

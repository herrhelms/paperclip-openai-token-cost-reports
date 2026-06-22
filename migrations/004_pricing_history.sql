-- 2.0.0 — pricing config becomes a snapshot history per company.
-- Each save appends a new row keyed by (company_id, effective_from).
-- Cost computation looks up the row with the greatest effective_from
-- that is <= event.occurred_at.

CREATE TABLE IF NOT EXISTS plugin_openai_token_cost_reports_5d9ad52d0e.pricing_config_history (
  company_id     TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  config_json    JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT,
  note           TEXT,
  PRIMARY KEY (company_id, effective_from)
);

CREATE INDEX IF NOT EXISTS pricing_config_history_company_eff_idx
  ON plugin_openai_token_cost_reports_5d9ad52d0e.pricing_config_history (company_id, effective_from DESC);

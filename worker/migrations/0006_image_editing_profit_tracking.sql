ALTER TABLE users ADD COLUMN paid_credit_balance INTEGER NOT NULL DEFAULT 0 CHECK (paid_credit_balance >= 0);

ALTER TABLE users ADD COLUMN promo_credit_balance INTEGER NOT NULL DEFAULT 0 CHECK (promo_credit_balance >= 0);

ALTER TABLE generations ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'generation'
  CHECK (operation_type IN ('generation', 'edit'));

ALTER TABLE generations ADD COLUMN input_image_count INTEGER NOT NULL DEFAULT 0 CHECK (input_image_count >= 0);

ALTER TABLE generations ADD COLUMN input_image_bytes INTEGER NOT NULL DEFAULT 0 CHECK (input_image_bytes >= 0);

ALTER TABLE generations ADD COLUMN paid_credits_used INTEGER NOT NULL DEFAULT 0 CHECK (paid_credits_used >= 0);

ALTER TABLE generations ADD COLUMN promo_credits_used INTEGER NOT NULL DEFAULT 0 CHECK (promo_credits_used >= 0);

ALTER TABLE generations ADD COLUMN input_text_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_text_tokens >= 0);

ALTER TABLE generations ADD COLUMN input_image_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_image_tokens >= 0);

ALTER TABLE generations ADD COLUMN output_image_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_image_tokens >= 0);

ALTER TABLE generations ADD COLUMN provider_cost_usd REAL NOT NULL DEFAULT 0 CHECK (provider_cost_usd >= 0);

ALTER TABLE generations ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'estimated'
  CHECK (cost_source IN ('provider_usage', 'provider_fixed', 'estimated'));

ALTER TABLE generations ADD COLUMN net_revenue_usd REAL NOT NULL DEFAULT 0 CHECK (net_revenue_usd >= 0);

ALTER TABLE generations ADD COLUMN gross_profit_usd REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_generations_operation_created ON generations(operation_type, created_at DESC);

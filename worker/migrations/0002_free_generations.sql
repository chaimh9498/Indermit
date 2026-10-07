ALTER TABLE users ADD COLUMN free_generations_remaining INTEGER NOT NULL DEFAULT 5 CHECK (free_generations_remaining >= 0);

ALTER TABLE generations ADD COLUMN charge_kind TEXT NOT NULL DEFAULT 'credits'
  CHECK (charge_kind IN ('credits', 'signup_free', 'anonymous_free'));

CREATE TABLE IF NOT EXISTS anonymous_usage (
  ip_hash TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

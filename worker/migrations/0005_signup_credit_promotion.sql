CREATE TABLE IF NOT EXISTS signup_credit_grants (
  user_id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 2 CHECK (credits > 0),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_signup_credit_grants_granted ON signup_credit_grants(granted_at);

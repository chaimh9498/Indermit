CREATE TABLE IF NOT EXISTS paid_beta_slots (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'paid')),
  checkout_session_id TEXT UNIQUE,
  reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS checkout_locks (
  user_id TEXT PRIMARY KEY,
  checkout_session_id TEXT NOT NULL UNIQUE,
  checkout_url TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_paid_beta_slots_status ON paid_beta_slots(status);

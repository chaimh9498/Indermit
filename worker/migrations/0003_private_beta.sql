CREATE TABLE IF NOT EXISTS beta_members (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'tester' CHECK (role IN ('tester', 'admin')),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_beta_members_joined ON beta_members(joined_at DESC);


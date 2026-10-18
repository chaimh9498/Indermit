CREATE TABLE IF NOT EXISTS plaa_i_matches (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  player_one_id TEXT NOT NULL,
  player_two_id TEXT,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'active', 'judging', 'completed', 'cancelled')),
  winner_user_id TEXT,
  judge_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (player_one_id) REFERENCES users(user_id),
  FOREIGN KEY (player_two_id) REFERENCES users(user_id),
  FOREIGN KEY (winner_user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS plaa_i_entries (
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  generation_id TEXT,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (match_id, user_id),
  FOREIGN KEY (match_id) REFERENCES plaa_i_matches(id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (generation_id) REFERENCES generations(id)
);

CREATE INDEX IF NOT EXISTS idx_plaa_i_matches_status_created ON plaa_i_matches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_plaa_i_matches_player_one ON plaa_i_matches(player_one_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaa_i_matches_player_two ON plaa_i_matches(player_two_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaa_i_entries_generation ON plaa_i_entries(generation_id);

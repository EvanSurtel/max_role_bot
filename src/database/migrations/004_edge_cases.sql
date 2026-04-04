-- Admin audit log
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_discord_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_admin ON admin_actions(admin_discord_id);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_type, target_id);

-- Evidence storage (persists after channels deleted)
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  submitted_by TEXT NOT NULL,
  link TEXT NOT NULL,
  notes TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_match ON evidence(match_id);

-- Pending transactions for crash recovery
CREATE TABLE IF NOT EXISTS pending_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  reference_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_tx_status ON pending_transactions(status);

-- Wallet lock + per-user encryption salt
ALTER TABLE wallets ADD COLUMN locked_at TEXT;
ALTER TABLE wallets ADD COLUMN encryption_salt TEXT;

-- Dispute category tracking
ALTER TABLE matches ADD COLUMN dispute_category_id TEXT;

-- Bot settings (key-value store for runtime config like seasons)
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- XP history for season leaderboards
CREATE TABLE IF NOT EXISTS xp_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  match_id INTEGER REFERENCES matches(id),
  match_type TEXT NOT NULL,
  xp_amount INTEGER NOT NULL,
  season TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_xp_history_user ON xp_history(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_history_season ON xp_history(season);
CREATE INDEX IF NOT EXISTS idx_xp_history_user_season ON xp_history(user_id, season);

-- Permanent wallet channel per user
ALTER TABLE users ADD COLUMN wallet_channel_id TEXT;

-- Player profile for registration and regional leaderboards
ALTER TABLE users ADD COLUMN server_username TEXT;
ALTER TABLE users ADD COLUMN cod_ign TEXT;
ALTER TABLE users ADD COLUMN cod_uid TEXT;
ALTER TABLE users ADD COLUMN cod_server TEXT;
ALTER TABLE users ADD COLUMN country_flag TEXT;
ALTER TABLE users ADD COLUMN region TEXT;
ALTER TABLE users ADD COLUMN tos_accepted_at TEXT;

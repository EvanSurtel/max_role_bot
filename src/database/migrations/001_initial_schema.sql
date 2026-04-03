-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT UNIQUE NOT NULL,
  accepted_tos INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Wallets table
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
  xrp_address TEXT UNIQUE NOT NULL,
  encrypted_seed TEXT NOT NULL,
  encryption_iv TEXT NOT NULL,
  encryption_tag TEXT NOT NULL,
  balance_available TEXT NOT NULL DEFAULT '0',
  balance_held TEXT NOT NULL DEFAULT '0',
  is_activated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Challenges table
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'wager',
  status TEXT NOT NULL DEFAULT 'pending_teammates',
  creator_user_id INTEGER NOT NULL REFERENCES users(id),
  acceptor_user_id INTEGER REFERENCES users(id),
  team_size INTEGER NOT NULL,
  game_modes TEXT NOT NULL,
  series_length INTEGER NOT NULL,
  entry_amount_drops TEXT NOT NULL DEFAULT '0',
  total_pot_drops TEXT NOT NULL DEFAULT '0',
  is_anonymous INTEGER NOT NULL DEFAULT 1,
  challenge_message_id TEXT,
  challenge_channel_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Challenge players table
CREATE TABLE IF NOT EXISTS challenge_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  team INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  status TEXT NOT NULL DEFAULT 'pending',
  funds_held INTEGER NOT NULL DEFAULT 0,
  notification_channel_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(challenge_id, user_id)
);

-- Matches table
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER UNIQUE NOT NULL REFERENCES challenges(id),
  status TEXT NOT NULL DEFAULT 'active',
  category_id TEXT,
  team1_voice_id TEXT,
  team1_text_id TEXT,
  team2_voice_id TEXT,
  team2_text_id TEXT,
  shared_voice_id TEXT,
  shared_text_id TEXT,
  voting_channel_id TEXT,
  captain1_vote INTEGER,
  captain2_vote INTEGER,
  winning_team INTEGER,
  vote_deadline TEXT,
  first_vote_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  challenge_id INTEGER REFERENCES challenges(id),
  amount_drops TEXT NOT NULL,
  xrpl_tx_hash TEXT,
  from_address TEXT,
  to_address TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Timers table
CREATE TABLE IF NOT EXISTS timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  reference_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_xrp_address ON wallets(xrp_address);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_challenges_creator_user_id ON challenges(creator_user_id);
CREATE INDEX IF NOT EXISTS idx_challenge_players_challenge_id ON challenge_players(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_players_user_id ON challenge_players(user_id);
CREATE INDEX IF NOT EXISTS idx_matches_challenge_id ON matches(challenge_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_challenge_id ON transactions(challenge_id);
CREATE INDEX IF NOT EXISTS idx_timers_handled_expires_at ON timers(handled, expires_at);

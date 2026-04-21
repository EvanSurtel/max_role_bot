-- Queue match persistence. Queue state used to live only in memory
-- (src/queue/state.js "All state is transient"). That was acceptable
-- when queue matches were XP-only and a restart just meant "drop the
-- lobby, no money at stake." The system is extending to real-money
-- queue matches, so we need to survive restarts and have a paper
-- trail of every phase transition.
--
-- Storage strategy: the in-memory QueueMatch object (with Maps for
-- players / captainVotes / roles / operators) is JSON-serialized into
-- these columns. The repo hydrates rows back into QueueMatch objects
-- on bot startup; the in-memory Map stays the hot path for reads,
-- DB is the cold-restart / audit path.
--
-- phase values: 'WAITING_VOICE' | 'CAPTAIN_VOTE' | 'CAPTAIN_PICK'
--               | 'ROLE_SELECT' | 'PLAY' | 'RESOLVED' | 'CANCELLED'
-- status derived for query convenience:
--   'active' when phase is pre-terminal, 'resolved' / 'cancelled' otherwise.

CREATE TABLE IF NOT EXISTS queue_matches (
  id INTEGER PRIMARY KEY,
  phase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',

  category_id TEXT,
  text_channel_id TEXT,
  voice_channel_id TEXT,

  players_json TEXT NOT NULL DEFAULT '{}',
  team1_json TEXT NOT NULL DEFAULT '[]',
  team2_json TEXT NOT NULL DEFAULT '[]',
  captains_json TEXT NOT NULL DEFAULT '{"team1":null,"team2":null}',
  captain_votes_json TEXT NOT NULL DEFAULT '{}',
  pick_order_json TEXT NOT NULL DEFAULT '[]',
  current_picker TEXT,
  pick_index INTEGER NOT NULL DEFAULT 0,
  team1_roles_json TEXT NOT NULL DEFAULT '{}',
  team2_roles_json TEXT NOT NULL DEFAULT '{}',
  team1_operators_json TEXT NOT NULL DEFAULT '{}',
  team2_operators_json TEXT NOT NULL DEFAULT '{}',
  maps_json TEXT NOT NULL DEFAULT '[]',
  games_played INTEGER NOT NULL DEFAULT 0,
  captain1_vote INTEGER,
  captain2_vote INTEGER,
  timer_deadline INTEGER,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_matches_status ON queue_matches(status);
CREATE INDEX IF NOT EXISTS idx_queue_matches_phase ON queue_matches(phase);

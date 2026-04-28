-- Support ticket system. A user clicks a category on the support
-- panel, the bot creates a private Discord channel for them, and
-- staff resolve the ticket inside that channel. One row per ticket;
-- channel_id ties the row to its Discord channel for reverse-lookup
-- when a Close button is clicked.
--
-- status lifecycle:
--   'open'         - active, channel exists
--   'closed'       - resolved by user or staff; channel deleted
--   'auto_closed'  - 7-day inactivity timer fired; channel deleted
--
-- closed_by is the closing user's discord_id (NOT users.id) so the
-- transcript can attribute the close to the right person even if
-- they're staff who isn't a registered Rank $ user.

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  channel_id TEXT NOT NULL UNIQUE,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  closed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets(channel_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

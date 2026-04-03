-- Add leaderboard stats columns to users table
ALTER TABLE users ADD COLUMN xp_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN total_wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN total_losses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN total_earnings_drops TEXT NOT NULL DEFAULT '0';
ALTER TABLE users ADD COLUMN total_wagered_drops TEXT NOT NULL DEFAULT '0';

-- Indexes for leaderboard queries
CREATE INDEX IF NOT EXISTS idx_users_xp_points ON users(xp_points DESC);
CREATE INDEX IF NOT EXISTS idx_users_total_earnings ON users(total_earnings_drops);

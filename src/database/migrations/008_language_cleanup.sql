-- 008: Rename wager terminology to cash match
-- Column renames
ALTER TABLE users RENAME COLUMN total_wagered_usdc TO total_entered_usdc;

-- Update challenge type values
UPDATE challenges SET type = 'cash_match' WHERE type = 'wager';

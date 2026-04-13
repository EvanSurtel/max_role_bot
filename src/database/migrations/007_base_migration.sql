-- Base chain migration + region-based deposit instructions.

-- Region column: GROUP_A (Coinbase Onramp, 0% fee) or GROUP_B (Bitget Wallet, 3-5% fee).
-- Set during verification. Determines which deposit instructions the user sees.
ALTER TABLE users ADD COLUMN deposit_region TEXT DEFAULT NULL;

-- Pending balance for the 36-hour dispute cooldown (from the spec).
-- When a match resolves after a dispute, the winner's payout goes to
-- pending_balance with a timer. After 36 hours it auto-moves to available.
ALTER TABLE users ADD COLUMN pending_balance TEXT NOT NULL DEFAULT '0';
ALTER TABLE users ADD COLUMN pending_release_at TEXT DEFAULT NULL;

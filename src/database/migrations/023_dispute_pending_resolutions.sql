-- Pending dispute resolutions.
--
-- When a match is resolved from a dispute, the 36-hour hold must
-- happen ON-CHAIN for self-custody users — funds stay in the
-- WagerEscrow contract, not the winner's Smart Wallet, because once
-- USDC is in the user's own wallet they can withdraw immediately and
-- the admin-review window is meaningless.
--
-- This table records the intended disbursement so the dispute_finalize
-- timer can call WagerEscrow.resolveMatch at release_at with the
-- exact winners + amounts. A cancellation row (admin reverses mid-
-- hold) uses status='cancelled'; a successful on-chain finalization
-- uses status='released' and records the tx hash.

CREATE TABLE IF NOT EXISTS dispute_pending_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL UNIQUE,
  challenge_id INTEGER NOT NULL,
  winning_player_ids TEXT NOT NULL,   -- JSON array of user_id
  total_pot_usdc TEXT NOT NULL,        -- smallest units
  release_at TEXT NOT NULL,            -- ISO timestamp
  status TEXT NOT NULL DEFAULT 'pending', -- pending | released | cancelled | failed
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dispute_pending_release_at ON dispute_pending_resolutions(release_at) WHERE status = 'pending';

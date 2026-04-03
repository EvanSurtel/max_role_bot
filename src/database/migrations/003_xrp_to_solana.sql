-- Migrate from XRP to Solana/USDC
-- Rename wallet columns
ALTER TABLE wallets RENAME COLUMN xrp_address TO solana_address;
ALTER TABLE wallets RENAME COLUMN encrypted_seed TO encrypted_private_key;

-- Rename challenge amount columns
ALTER TABLE challenges RENAME COLUMN entry_amount_drops TO entry_amount_usdc;
ALTER TABLE challenges RENAME COLUMN total_pot_drops TO total_pot_usdc;

-- Rename transaction columns
ALTER TABLE transactions RENAME COLUMN amount_drops TO amount_usdc;
ALTER TABLE transactions RENAME COLUMN xrpl_tx_hash TO solana_tx_signature;

-- Rename user leaderboard columns
ALTER TABLE users RENAME COLUMN total_earnings_drops TO total_earnings_usdc;
ALTER TABLE users RENAME COLUMN total_wagered_drops TO total_wagered_usdc;

-- Update indexes (drop old, create new)
DROP INDEX IF EXISTS idx_wallets_xrp_address;
CREATE INDEX IF NOT EXISTS idx_wallets_solana_address ON wallets(solana_address);

-- 009: Rename legacy Solana column names to Base
ALTER TABLE wallets RENAME COLUMN solana_address TO base_address;
ALTER TABLE transactions RENAME COLUMN solana_tx_signature TO tx_hash;

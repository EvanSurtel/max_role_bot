-- 009: Rename legacy column names to generic chain-agnostic names
ALTER TABLE wallets RENAME COLUMN solana_address TO address;
ALTER TABLE wallets RENAME COLUMN encrypted_private_key TO account_ref;
ALTER TABLE transactions RENAME COLUMN solana_tx_signature TO tx_hash;

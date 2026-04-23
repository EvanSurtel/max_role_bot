-- After a user migrates to self-custody we flip wallet.address to
-- their new Coinbase Smart Wallet address so that the deposit poller,
-- Onramp routing, and the wallet panel all point at the self-custody
-- wallet (the one the user controls) going forward.
--
-- We still need to remember where the legacy CDP Server Wallet funds
-- live, because scripts/migrate-funds-to-smart-wallet.js has to read
-- that balance to sweep it. This column preserves it — populated on
-- migration, never changed after.

ALTER TABLE wallets ADD COLUMN legacy_cdp_address TEXT;

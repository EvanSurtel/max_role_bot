-- Self-custody migration: Coinbase Smart Wallet + Spend Permissions.
--
-- Up to this point every user's wallet has been a CDP Server Wallet
-- (Smart Account owned by an EOA we control via API). That model put
-- our backend in the signing path for every user transaction —
-- functionally custodial. To meet Coinbase CDP Onramp's review
-- expectations and reduce regulatory exposure (FINTRAC / state MTL
-- analyses), we're migrating to:
--
--   - Coinbase Smart Wallet (user's passkey is the only owner) per user
--   - SpendPermissionManager-bounded spender role for our backend
--     (contract 0xf85210B21cC50302F477BA56686d2019dC9b67Ad on Base mainnet)
--   - Web surface for passkey-gated user signing (setup, withdraw, renew)
--   - User funds always sit in their own Smart Wallet; we pull bounded
--     amounts on match entry via on-chain SpendPermissionManager.spend
--
-- This migration adds the schema needed to coexist both wallet types
-- during the rollout window. New users get Coinbase Smart Wallets;
-- existing users keep their CDP Server Wallets until they opt into
-- migration (lazy migration via prompt on next deposit/withdraw).

-- ─── wallets table: track wallet type + Smart Wallet address ────────
--
-- The legacy `address` column has historically held the CDP Server
-- Wallet's Smart Account address (re-purposed Solana column). After
-- migration, `address` continues to hold whatever wallet address is
-- *active* for that user (Server Wallet OR Smart Wallet) — the
-- deposit poller and balance lookups don't need to branch.
--
-- `wallet_type` distinguishes which signing path applies:
--   'cdp_server'         — legacy: backend signs via CDP API
--   'coinbase_smart_wallet' — new: user signs via passkey, backend
--                              pulls via SpendPermission only
--
-- `smart_wallet_address` is set when a user has provisioned a Coinbase
-- Smart Wallet (via the web surface). Stored separately from `address`
-- so we can detect partially-migrated users (Smart Wallet created, but
-- they haven't yet swept funds from old Server Wallet).

ALTER TABLE wallets ADD COLUMN wallet_type TEXT NOT NULL DEFAULT 'cdp_server';
ALTER TABLE wallets ADD COLUMN smart_wallet_address TEXT;
ALTER TABLE wallets ADD COLUMN migrated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_wallets_type ON wallets(wallet_type);
CREATE INDEX IF NOT EXISTS idx_wallets_smart_address ON wallets(smart_wallet_address)
  WHERE smart_wallet_address IS NOT NULL;

-- ─── spend_permissions table ────────────────────────────────────────
--
-- One row per active SpendPermission a user has granted to our backend.
-- A user may have multiple permissions over time (rotated, replaced, or
-- granted distinct caps) — we treat the most recently approved
-- non-revoked, non-expired row as the "active" one for that user.
--
-- The `signature` column holds the EIP-712 signature bytes (hex string)
-- the user produced via their Smart Wallet passkey. We use this to
-- submit the on-chain `approveWithSignature` call from our backend
-- (so the user only signs once in the browser; we lift it on-chain
-- when convenient).
--
-- `permission_hash` is the SpendPermissionManager-computed hash of the
-- struct — used for deduplication, lookups, and revoke calls. We
-- compute it locally and verify against the contract.
--
-- The `account` / `spender` / `token` columns are technically derivable
-- from joins, but storing them explicitly makes audit + debugging
-- trivial and matches what we'll need to send back to the contract.

CREATE TABLE IF NOT EXISTS spend_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),

  -- EIP-712 SpendPermission struct, exactly as signed by the user.
  -- All address fields stored 0x-prefixed lowercase. uint160/uint256
  -- amounts stored as TEXT to avoid SQLite int precision loss.
  account TEXT NOT NULL,                    -- user's Coinbase Smart Wallet
  spender TEXT NOT NULL,                    -- our backend Smart Account (escrow-owner-smart)
  token TEXT NOT NULL,                      -- USDC contract on Base
  allowance TEXT NOT NULL,                  -- per-period cap, USDC 6dec smallest units
  period INTEGER NOT NULL,                  -- rolling window in seconds
  start_ts INTEGER NOT NULL,                -- uint48 unix seconds
  end_ts INTEGER NOT NULL,                  -- uint48 unix seconds (effectively-never = 281474976710655)
  salt TEXT NOT NULL,                       -- uint256 nonce, hex string
  extra_data TEXT NOT NULL DEFAULT '0x',

  -- User's EIP-712 signature over the struct (hex string with 0x).
  -- May be ERC-6492-wrapped if the Smart Wallet wasn't yet deployed
  -- when the user signed.
  signature TEXT NOT NULL,

  -- SpendPermissionManager.getHash(struct) result. Used for on-chain
  -- isValid / revoke calls and as the natural dedupe key.
  permission_hash TEXT NOT NULL,

  -- Lifecycle:
  --   pending     — user signed in browser, we haven't yet submitted
  --                 approveWithSignature on-chain
  --   approved    — on-chain approveWithSignature succeeded; we can
  --                 call spend()
  --   revoked     — user (or backend) revoked; we should not call
  --                 spend() against this row
  --   expired     — end_ts has passed; soft-marked by the sweeper
  --   superseded  — replaced by a newer permission for the same
  --                 (account, spender, token); kept for audit
  status TEXT NOT NULL DEFAULT 'pending',

  approved_tx_hash TEXT,                    -- approveWithSignature on-chain tx
  revoked_tx_hash TEXT,                     -- revoke / revokeAsSpender on-chain tx
  approved_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Permission_hash should be globally unique (it's a keccak256 of the
  -- struct including a random salt). UNIQUE so a duplicate submission
  -- from the browser doesn't insert a second row.
  UNIQUE(permission_hash)
);

CREATE INDEX IF NOT EXISTS idx_spend_permissions_user_active
  ON spend_permissions(user_id, status)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_spend_permissions_account
  ON spend_permissions(account);

-- ─── discord_link_nonces ─────────────────────────────────────────────
--
-- One-time tokens we hand the user via Discord DM, redeemed at the web
-- surface to bind (Discord ID -> Smart Wallet address). Short TTL,
-- single-use, server-validated. Without this, an attacker who gets
-- the wallet.rank.gg URL could try to claim a wallet for someone
-- else's Discord identity.

CREATE TABLE IF NOT EXISTS discord_link_nonces (
  nonce TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,                    -- 'setup' | 'withdraw' | 'renew'
  expires_at TEXT NOT NULL,                 -- ISO timestamp, 10-minute TTL
  consumed_at TEXT,                         -- non-null = already used
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_link_nonces_expires
  ON discord_link_nonces(expires_at);

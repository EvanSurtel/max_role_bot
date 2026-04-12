-- MoonPay on-ramp / off-ramp transaction correlation table.
--
-- Records every MoonPay transaction the bot initiates so webhooks
-- arriving later can be correlated back to a specific user and can
-- drive state transitions (e.g. offramp "waiting for deposit" →
-- submit USDC transfer).
--
-- external_id is a UUID we generate when initiating the flow and
-- pass to MoonPay as externalTransactionId. We look rows up by this
-- when a webhook arrives. moonpay_id gets filled in from the webhook
-- payload once MoonPay has assigned its own transaction ID.

CREATE TABLE IF NOT EXISTS moonpay_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE NOT NULL,
  moonpay_id TEXT UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                                    -- 'onramp' | 'offramp'
  status TEXT NOT NULL DEFAULT 'pending',                -- pending | waitingForDeposit | processing | completed | failed | insufficient_balance
  amount_usdc TEXT,                                      -- amount in USDC (human decimal from MoonPay)
  fiat_amount TEXT,
  fiat_currency TEXT,
  deposit_address TEXT,                                  -- for offramps: MoonPay's sell deposit address
  deposit_tx_signature TEXT,                             -- Solana signature once we transfer USDC to MoonPay
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_moonpay_tx_user ON moonpay_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_moonpay_tx_external ON moonpay_transactions(external_id);
CREATE INDEX IF NOT EXISTS idx_moonpay_tx_moonpay ON moonpay_transactions(moonpay_id);
CREATE INDEX IF NOT EXISTS idx_moonpay_tx_status ON moonpay_transactions(status);

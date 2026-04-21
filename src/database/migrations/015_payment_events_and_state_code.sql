-- Payment-event ledger + US state_code support.
--
-- `payment_events` is an append-only log of every webhook payload we
-- accept (Changelly, Coinbase), keyed by an event id provided by the
-- sender. Lets the handlers dedupe on retries — Coinbase and Changelly
-- both replay failed webhooks, so the same order-completed event can
-- arrive multiple times. First write wins.
--
-- `users.state_code` is the ISO 3166-2 US state code (e.g. "NY", "CA").
-- Changelly requires it when country=US. Nullable because existing rows
-- and non-US users don't have one; onboarding will start collecting it
-- for US users in a follow-up.

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,         -- 'changelly' | 'coinbase'
  event_id TEXT NOT NULL,         -- sender-provided dedupe key
  event_type TEXT,                -- e.g. 'onramp.transaction.updated'
  order_id TEXT,                  -- provider's internal order id, if any
  status TEXT,                    -- final status we observed
  payload_json TEXT NOT NULL,     -- raw body for audit
  received_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_dedup
  ON payment_events(provider, event_id);

ALTER TABLE users ADD COLUMN state_code TEXT;

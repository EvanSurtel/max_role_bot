-- Wert requires full document KYC once a user crosses $1,000 USD
-- lifetime in their typed-only LKYC flow. We track cumulative deposits
-- per user in USD (as TEXT to avoid float rounding on fractional
-- dollars) and surface a warning in the deposit panel as the user
-- approaches the cap, so they can pre-emptively switch to Transak
-- (full KYC but lower fees) without being surprised mid-flow by
-- Wert's own KYC gate.
--
-- Incremented in the Changelly webhook handler on `order_completed`
-- when the originating order had providerCode='wert'. Never decremented.

ALTER TABLE users ADD COLUMN wert_lifetime_usd TEXT DEFAULT '0';

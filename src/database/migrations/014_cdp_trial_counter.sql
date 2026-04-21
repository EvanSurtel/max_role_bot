-- CDP trial counter: Coinbase puts new Onramp projects in trial mode with a
-- 25-transaction × $5 cap (shared across Onramp + Offramp). We count every
-- completed CDP Onramp webhook here so the payment router can auto-fall-back
-- to Wert once the trial is exhausted, and so we stop burning the cap once
-- we hit it. Uses bot_settings since that's already the kv store we use for
-- current_season / matches_paused.

INSERT OR IGNORE INTO bot_settings (key, value) VALUES ('cdp_trial_counter', '0');

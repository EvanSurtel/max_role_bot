-- Withdrawal verification state — fix the "DB drift" race where a
-- UserOp is submitted on-chain but the bot's waitForUserOperation
-- throws (timeout, network blip) before confirmation. Before this
-- migration the bot would credit the USDC back to the user's DB
-- balance on any error, but the UserOp could still land 1-2 min
-- later, leaving DB > on-chain forever (user has phantom credit,
-- requires admin reconciliation).
--
-- New columns:
--   user_op_hash           — CDP UserOperation hash, lets us re-query
--                            the chain to learn the true outcome.
--   smart_account_address  — needed for cdp.evm.getUserOperation().
--
-- New status value (not a schema change, just a string convention):
--   'pending_verification' — the on-chain state is unknown; a sweeper
--                            service will poll and either flip to
--                            'completed' or credit-back + mark 'failed'
--                            after a verification window elapses.

ALTER TABLE transactions ADD COLUMN user_op_hash TEXT;
ALTER TABLE transactions ADD COLUMN smart_account_address TEXT;

CREATE INDEX IF NOT EXISTS idx_tx_pending_verification
  ON transactions(status, type)
  WHERE status = 'pending_verification';

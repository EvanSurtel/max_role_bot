// Transaction log CRUD + pending inflow queries for deposit reconciliation.
const db = require('../db');

const stmts = {
  findById: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  findByUserId: db.prepare('SELECT * FROM transactions WHERE user_id = ?'),
  findByChallengeId: db.prepare('SELECT * FROM transactions WHERE challenge_id = ?'),
  create: db.prepare(`
    INSERT INTO transactions (type, user_id, challenge_id, amount_usdc, tx_hash, from_address, to_address, status, memo)
    VALUES (@type, @userId, @challengeId, @amountUsdc, @txHash, @fromAddress, @toAddress, @status, @memo)
    RETURNING *
  `),
  updateStatus: db.prepare('UPDATE transactions SET status = ? WHERE id = ?'),
  updateStatusAndHash: db.prepare('UPDATE transactions SET status = ?, tx_hash = ?, memo = COALESCE(?, memo) WHERE id = ?'),
  findPendingOutflowsForUser: db.prepare(`
    SELECT * FROM transactions
    WHERE user_id = ?
      AND type IN ('withdrawal', 'refund')
      AND status IN ('pending_onchain', 'pending_verification')
  `),
  // Find recent pending-onchain inflows (disbursement / refund /
  // dispute_hold_credit) for a user so the deposit poller can match
  // incoming USDC to an already-known intent rather than mis-labeling
  // it as a fresh deposit. "pending_onchain" is set when we log the
  // INTENT before sending the tx; it's flipped to "completed" after
  // DB credit succeeds. Anything still pending when the poller sees
  // matching USDC is a partially-applied flow we need to reconcile.
  findPendingInflowsForUser: db.prepare(`
    SELECT * FROM transactions
    WHERE user_id = ?
      AND type IN ('disbursement', 'refund', 'dispute_hold_credit')
      AND status = 'pending_onchain'
      AND created_at >= datetime('now', ?)
    ORDER BY id ASC
  `),
};

const transactionRepo = {
  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByUserId(userId) {
    return stmts.findByUserId.all(userId);
  },

  findByChallengeId(challengeId) {
    return stmts.findByChallengeId.all(challengeId);
  },

  /**
   * Return pending-on-chain inflow tx rows for a user (disbursement,
   * refund, dispute_hold_credit) created within the last `lookbackSec`
   * seconds. Used by the deposit poller to reconcile incoming USDC
   * with previously-logged intent instead of mis-tagging it as a new
   * deposit.
   */
  findPendingInflowsForUser(userId, lookbackSec = 5400) {
    return stmts.findPendingInflowsForUser.all(userId, `-${Number(lookbackSec)} seconds`);
  },

  create({ type, userId, challengeId, amountUsdc, txHash, fromAddress, toAddress, status, memo }) {
    return stmts.create.get({
      type,
      userId: userId || null,
      challengeId: challengeId || null,
      amountUsdc,
      txHash: txHash || null,
      fromAddress: fromAddress || null,
      toAddress: toAddress || null,
      status: status || 'pending',
      memo: memo || null,
    });
  },

  updateStatus(id, status) {
    return stmts.updateStatus.run(status, id);
  },

  updateStatusAndHash(id, status, txHash, memoAppend = null) {
    return stmts.updateStatusAndHash.run(status, txHash, memoAppend, id);
  },

  /**
   * Return pending outbound tx rows for a user (withdrawal, refund)
   * whose on-chain state is still unresolved. Used by reconciliation
   * to factor in-flight outflows into the expected DB vs on-chain
   * diff — otherwise every mid-withdraw poll alerts as a mismatch.
   */
  findPendingOutflowsForUser(userId) {
    return stmts.findPendingOutflowsForUser.all(userId);
  },

  /**
   * Return pending inbound tx rows for a user that have NOT yet been
   * credited to their DB balance (disbursement / refund TO user /
   * dispute_hold_credit). Same idea as findPendingOutflowsForUser but
   * for the inflow direction — on-chain may already have the credit
   * while DB hasn't caught up.
   */
  findPendingInflowsForUserAll(userId) {
    return db.prepare(`
      SELECT * FROM transactions
      WHERE user_id = ?
        AND type IN ('disbursement', 'refund', 'dispute_hold_credit')
        AND status IN ('pending_onchain', 'pending_verification')
    `).all(userId);
  },
};

module.exports = transactionRepo;

const db = require('../db');

const stmts = {
  findById: db.prepare('SELECT * FROM transactions WHERE id = ?'),
  findByUserId: db.prepare('SELECT * FROM transactions WHERE user_id = ?'),
  findByChallengeId: db.prepare('SELECT * FROM transactions WHERE challenge_id = ?'),
  create: db.prepare(`
    INSERT INTO transactions (type, user_id, challenge_id, amount_usdc, solana_tx_signature, from_address, to_address, status, memo)
    VALUES (@type, @userId, @challengeId, @amountUsdc, @solanaTxSignature, @fromAddress, @toAddress, @status, @memo)
    RETURNING *
  `),
  updateStatus: db.prepare('UPDATE transactions SET status = ? WHERE id = ?'),
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

  create({ type, userId, challengeId, amountUsdc, solanaTxSignature, fromAddress, toAddress, status, memo }) {
    return stmts.create.get({
      type,
      userId: userId || null,
      challengeId: challengeId || null,
      amountUsdc,
      solanaTxSignature: solanaTxSignature || null,
      fromAddress: fromAddress || null,
      toAddress: toAddress || null,
      status: status || 'pending',
      memo: memo || null,
    });
  },

  updateStatus(id, status) {
    return stmts.updateStatus.run(status, id);
  },
};

module.exports = transactionRepo;

// Pending on-chain transaction tracking.
const db = require('../db');

const stmts = {
  create: db.prepare(`
    INSERT INTO pending_transactions (type, reference_id, payload, status)
    VALUES (?, ?, ?, 'pending')
    RETURNING *
  `),
  findPending: db.prepare("SELECT * FROM pending_transactions WHERE status = 'pending'"),
  updateStatus: db.prepare(`
    UPDATE pending_transactions SET status = ?, attempts = attempts + 1, last_attempt = datetime('now')
    WHERE id = ?
  `),
  markCompleted: db.prepare("UPDATE pending_transactions SET status = 'completed' WHERE id = ?"),
};

const pendingTxRepo = {
  create(type, referenceId, payload) {
    return stmts.create.get(type, referenceId, JSON.stringify(payload));
  },

  findPending() {
    return stmts.findPending.all();
  },

  markCompleted(id) {
    return stmts.markCompleted.run(id);
  },

  updateStatus(id, status) {
    return stmts.updateStatus.run(status, id);
  },
};

module.exports = pendingTxRepo;

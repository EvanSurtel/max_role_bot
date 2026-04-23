// CRUD + lookups for the spend_permissions table.
//
// Each row represents one EIP-712 SpendPermission a user has signed
// granting our backend bounded ability to pull USDC from their
// Coinbase Smart Wallet via the on-chain SpendPermissionManager.
//
// Lifecycle:
//   pending     → user signed in browser, on-chain approve not yet sent
//   approved    → on-chain approveWithSignature succeeded; spend() works
//   revoked     → user / backend revoked
//   expired     → end_ts has passed (sweeper updates this)
//   superseded  → replaced by a newer permission for same user

const db = require('../db');

const stmts = {
  insert: db.prepare(`
    INSERT INTO spend_permissions (
      user_id, account, spender, token, allowance, period,
      start_ts, end_ts, salt, extra_data, signature, permission_hash, status
    ) VALUES (
      @userId, @account, @spender, @token, @allowance, @period,
      @startTs, @endTs, @salt, @extraData, @signature, @permissionHash, @status
    )
    RETURNING *
  `),
  findById: db.prepare('SELECT * FROM spend_permissions WHERE id = ?'),
  findByHash: db.prepare('SELECT * FROM spend_permissions WHERE permission_hash = ?'),
  findActiveForUser: db.prepare(`
    SELECT * FROM spend_permissions
    WHERE user_id = ? AND status = 'approved'
      AND end_ts > unixepoch('now')
    ORDER BY id DESC
    LIMIT 1
  `),
  findAllForUser: db.prepare(`
    SELECT * FROM spend_permissions
    WHERE user_id = ?
    ORDER BY id DESC
  `),
  setApproved: db.prepare(`
    UPDATE spend_permissions
    SET status = 'approved',
        approved_tx_hash = ?,
        approved_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `),
  setRevoked: db.prepare(`
    UPDATE spend_permissions
    SET status = 'revoked',
        revoked_tx_hash = ?,
        revoked_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `),
  setSuperseded: db.prepare(`
    UPDATE spend_permissions
    SET status = 'superseded', updated_at = datetime('now')
    WHERE user_id = ? AND status IN ('approved', 'pending') AND id != ?
  `),
  markExpired: db.prepare(`
    UPDATE spend_permissions
    SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'approved' AND end_ts <= unixepoch('now')
  `),
};

const spendPermissionRepo = {
  /**
   * Insert a new SpendPermission row. Caller has already verified the
   * EIP-712 signature against the user's Smart Wallet address.
   * Status starts 'pending' until on-chain approveWithSignature lands.
   *
   * If a permission with the same on-chain hash already exists this
   * INSERT throws a UNIQUE violation — caller should treat as a
   * duplicate browser submission (idempotent re-grant of same params).
   */
  create(row) {
    return stmts.insert.get({
      userId: row.userId,
      account: row.account.toLowerCase(),
      spender: row.spender.toLowerCase(),
      token: row.token.toLowerCase(),
      allowance: String(row.allowance),
      period: row.period,
      startTs: row.startTs,
      endTs: row.endTs,
      salt: String(row.salt),
      extraData: row.extraData || '0x',
      signature: row.signature,
      permissionHash: row.permissionHash.toLowerCase(),
      status: 'pending',
    });
  },

  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByHash(hash) {
    return stmts.findByHash.get(String(hash).toLowerCase()) || null;
  },

  /**
   * Return the user's currently-active permission (approved + not
   * expired). Used by the spend service to decide whether we can pull
   * funds for a match without prompting the user to re-sign.
   */
  findActiveForUser(userId) {
    return stmts.findActiveForUser.get(userId) || null;
  },

  findAllForUser(userId) {
    return stmts.findAllForUser.all(userId);
  },

  /**
   * Atomically: mark a row 'approved' AND mark all OTHER pending /
   * approved rows for the same user as 'superseded'. This is what the
   * sweeper-or-callback runs once approveWithSignature confirms on-chain.
   * Wrapping in db.transaction so the active-permission invariant
   * (one approved per user at most) holds even on concurrent renewals.
   */
  markApprovedAndSupersedeOthers(id, txHash) {
    const tx = db.transaction(() => {
      const row = stmts.findById.get(id);
      if (!row) throw new Error(`spend_permission ${id} not found`);
      stmts.setSuperseded.run(row.user_id, id);
      stmts.setApproved.run(txHash, id);
    });
    tx();
  },

  setRevoked(id, txHash) {
    return stmts.setRevoked.run(txHash || null, id);
  },

  /**
   * Sweep job: flip end_ts <= now permissions from 'approved' to
   * 'expired'. Cheap; safe to call from a periodic timer.
   */
  markExpiredSweep() {
    return stmts.markExpired.run();
  },
};

module.exports = spendPermissionRepo;

// Wallet table CRUD + atomic balance operations (hold, release, credit).
const db = require('../db');

const stmts = {
  findByUserId: db.prepare('SELECT * FROM wallets WHERE user_id = ?'),
  findByAddress: db.prepare('SELECT * FROM wallets WHERE address = ?'),
  create: db.prepare(`
    INSERT INTO wallets (user_id, address, account_ref, smart_account_ref, encryption_iv, encryption_tag, encryption_salt)
    VALUES (@userId, @address, @accountRef, @smartAccountRef, '', '', '')
    RETURNING *
  `),
  updateBalance: db.prepare(`
    UPDATE wallets SET balance_available = @balanceAvailable, balance_held = @balanceHeld
    WHERE user_id = @userId
  `),
  setBalances: db.prepare(`
    UPDATE wallets SET balance_available = @balanceAvailable, balance_held = @balanceHeld
    WHERE user_id = @userId
  `),
  activate: db.prepare('UPDATE wallets SET is_activated = 1 WHERE user_id = ?'),
  getAllActivated: db.prepare('SELECT * FROM wallets WHERE is_activated = 1'),
  getAll: db.prepare('SELECT * FROM wallets'),
  lock: db.prepare("UPDATE wallets SET locked_at = datetime('now') WHERE user_id = ? AND (locked_at IS NULL OR locked_at < datetime('now', '-60 seconds'))"),
  unlock: db.prepare('UPDATE wallets SET locked_at = NULL WHERE user_id = ?'),
};

const holdFundsTx = db.transaction((userId, amountUsdc) => {
  const wallet = stmts.findByUserId.get(userId);
  if (!wallet) throw new Error('Wallet not found');

  const available = BigInt(wallet.balance_available);
  const held = BigInt(wallet.balance_held);
  const amount = BigInt(amountUsdc);

  if (available < amount) {
    throw new Error('Insufficient available balance to hold funds');
  }

  stmts.setBalances.run({
    userId,
    balanceAvailable: (available - amount).toString(),
    balanceHeld: (held + amount).toString(),
  });
});

const releaseFundsTx = db.transaction((userId, amountUsdc) => {
  const wallet = stmts.findByUserId.get(userId);
  if (!wallet) throw new Error('Wallet not found');

  const available = BigInt(wallet.balance_available);
  const held = BigInt(wallet.balance_held);
  const amount = BigInt(amountUsdc);

  if (held < amount) {
    throw new Error('Insufficient held balance to release funds');
  }

  stmts.setBalances.run({
    userId,
    balanceAvailable: (available + amount).toString(),
    balanceHeld: (held - amount).toString(),
  });
});

// Credit a positive delta to balance_available using a fresh DB read
// inside a transaction — prevents the stale-read / stomped-balance
// bug where a caller holds a wallet snapshot through an `await`
// (e.g. an on-chain transfer) and then writes back `snapshot.avail
// + delta`, silently clobbering any deposit / withdraw / hold that
// happened in the meantime.
//
// Use this whenever you want to ADD to a user's available balance
// after an async side-effect rather than the read-modify-write
// pattern that audits flagged in C2, H3 and C4.
const creditAvailableTx = db.transaction((userId, deltaUsdc) => {
  const wallet = stmts.findByUserId.get(userId);
  if (!wallet) throw new Error('Wallet not found');
  const freshAvail = BigInt(wallet.balance_available);
  const delta = BigInt(deltaUsdc);
  if (delta < 0n) throw new Error('creditAvailable delta must be non-negative');
  stmts.setBalances.run({
    userId,
    balanceAvailable: (freshAvail + delta).toString(),
    balanceHeld: wallet.balance_held, // preserve held exactly as stored right now
  });
});

// Credit winnings to the user's pending_balance in the users table
// (not balance_available in wallets). Used for the 36-hour dispute hold.
const creditPendingTx = db.transaction((userId, deltaUsdc, releaseAt) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  const currentPending = BigInt(user.pending_balance || '0');
  const delta = BigInt(deltaUsdc);
  if (delta < 0n) throw new Error('creditPending delta must be non-negative');
  db.prepare('UPDATE users SET pending_balance = ?, pending_release_at = ? WHERE id = ?').run(
    (currentPending + delta).toString(),
    releaseAt,
    userId,
  );
});

// Move all pending_balance to wallet balance_available. Called when the
// 36-hour dispute hold timer fires.
const releasePendingTx = db.transaction((userId) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  const pendingAmount = BigInt(user.pending_balance || '0');
  if (pendingAmount <= 0n) return '0';

  // Zero out pending balance and release timestamp
  db.prepare("UPDATE users SET pending_balance = '0', pending_release_at = NULL WHERE id = ?").run(userId);

  // Credit wallet available balance
  const wallet = stmts.findByUserId.get(userId);
  if (!wallet) throw new Error('Wallet not found');
  const freshAvail = BigInt(wallet.balance_available);
  stmts.setBalances.run({
    userId,
    balanceAvailable: (freshAvail + pendingAmount).toString(),
    balanceHeld: wallet.balance_held,
  });

  return pendingAmount.toString();
});

const walletRepo = {
  findByUserId(userId) {
    return stmts.findByUserId.get(userId) || null;
  },

  findByAddress(address) {
    return stmts.findByAddress.get(address) || null;
  },

  create({ userId, address, accountRef, smartAccountRef }) {
    return stmts.create.get({ userId, address, accountRef, smartAccountRef: smartAccountRef || null });
  },

  updateBalance(userId, { balanceAvailable, balanceHeld }) {
    return stmts.updateBalance.run({ userId, balanceAvailable, balanceHeld });
  },

  holdFunds(userId, amountUsdc) {
    return holdFundsTx(userId, amountUsdc);
  },

  releaseFunds(userId, amountUsdc) {
    return releaseFundsTx(userId, amountUsdc);
  },

  /**
   * Atomically credit a non-negative delta to balance_available using
   * a fresh DB read. Callers doing read-then-async-then-write should
   * use this instead of walletRepo.updateBalance to avoid clobbering
   * concurrent balance changes.
   */
  creditAvailable(userId, deltaUsdc) {
    return creditAvailableTx(userId, deltaUsdc);
  },

  activate(userId) {
    return stmts.activate.run(userId);
  },

  getAllActivated() {
    return stmts.getAllActivated.all();
  },

  getAll() {
    return stmts.getAll.all();
  },

  /**
   * Credit winnings to the user's pending_balance (36-hour dispute hold).
   * @param {number} userId - user ID
   * @param {string} deltaUsdc - amount in smallest USDC units
   * @param {string} releaseAt - ISO timestamp when the hold expires
   */
  creditPending(userId, deltaUsdc, releaseAt) {
    return creditPendingTx(userId, deltaUsdc, releaseAt);
  },

  /**
   * Move all pending_balance to wallet balance_available.
   * Returns the amount that was released (string).
   */
  releasePending(userId) {
    return releasePendingTx(userId);
  },

  /**
   * Attempt to acquire a lock on the wallet. Returns true if acquired.
   * Lock auto-expires after 60 seconds (stale lock protection).
   */
  acquireLock(userId) {
    const result = stmts.lock.run(userId);
    return result.changes > 0;
  },

  releaseLock(userId) {
    stmts.unlock.run(userId);
  },
};

module.exports = walletRepo;

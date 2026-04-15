const db = require('../db');

const stmts = {
  findByUserId: db.prepare('SELECT * FROM wallets WHERE user_id = ?'),
  findByAddress: db.prepare('SELECT * FROM wallets WHERE base_address = ?'),
  create: db.prepare(`
    INSERT INTO wallets (user_id, base_address, encrypted_private_key, encryption_iv, encryption_tag, encryption_salt)
    VALUES (@userId, @baseAddress, @encryptedPrivateKey, @encryptionIv, @encryptionTag, @encryptionSalt)
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

const walletRepo = {
  findByUserId(userId) {
    return stmts.findByUserId.get(userId) || null;
  },

  findByAddress(address) {
    return stmts.findByAddress.get(address) || null;
  },

  create({ userId, baseAddress, encryptedPrivateKey, encryptionIv, encryptionTag, encryptionSalt }) {
    return stmts.create.get({ userId, baseAddress, encryptedPrivateKey, encryptionIv, encryptionTag, encryptionSalt: encryptionSalt || null });
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

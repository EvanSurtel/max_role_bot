// User table CRUD + stats (XP, wins, losses, earnings, language, cash match stats).
const db = require('../db');

// Starting XP for a brand-new user. This MUST match STARTING_XP in
// seasonPanel.js — new users and season-reset users should land on
// the same baseline so the leaderboard + rank roles stay consistent.
const STARTING_XP = 500;

const stmts = {
  findById: db.prepare('SELECT * FROM users WHERE id = ?'),
  findByDiscordId: db.prepare('SELECT * FROM users WHERE discord_id = ?'),
  // Explicitly set xp_points to the starting baseline instead of
  // relying on the 0 DB default — without this, new users joined
  // mid-season with 0 XP while everyone else was at 500, and a
  // single loss dropped them below zero.
  create: db.prepare('INSERT INTO users (discord_id, xp_points) VALUES (?, ' + STARTING_XP + ') RETURNING *'),
  // Accepting TOS also bumps xp_points up to STARTING_XP if the row
  // is sitting below it. Reason: rows created before STARTING_XP=500
  // landed in userRepo.create (pre-Apr-2026) defaulted to 0 via the
  // DB column default. Those legacy rows could be created anonymously
  // by the language picker (`languageSwitcher.js`), so a user might
  // exist with xp_points=0 long before they ever go through onboarding.
  // When they finally register, we want them on the 500 baseline like
  // everyone else. We use MAX(...) instead of unconditional set so we
  // never CLOBBER a higher XP — e.g. if a user accidentally re-runs
  // acceptTos via some admin path after legitimately earning XP.
  acceptTos: db.prepare('UPDATE users SET accepted_tos = 1, xp_points = MAX(xp_points, ' + STARTING_XP + ') WHERE id = ?'),
  setLanguage: db.prepare('UPDATE users SET language = ? WHERE discord_id = ?'),

  // Leaderboard stats. Floors at 0 — a player can never drop below
  // 0 XP. If the requested delta would go negative, only the portion
  // that brings them to 0 is applied (see addXpFloored below).
  addXp: db.prepare('UPDATE users SET xp_points = xp_points + ? WHERE id = ?'),
  addWin: db.prepare('UPDATE users SET total_wins = total_wins + 1 WHERE id = ?'),
  addLoss: db.prepare('UPDATE users SET total_losses = total_losses + 1 WHERE id = ?'),

  getXpLeaderboard: db.prepare(
    'SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0 ORDER BY xp_points DESC LIMIT ?'
  ),
  getEarningsLeaderboard: db.prepare(
    'SELECT * FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0 ORDER BY CAST(total_earnings_usdc AS INTEGER) DESC LIMIT ?'
  ),
  incrementCashWin: db.prepare('UPDATE users SET cash_wins = cash_wins + 1 WHERE id = ?'),
  incrementCashLoss: db.prepare('UPDATE users SET cash_losses = cash_losses + 1 WHERE id = ?'),
};

// Apply an XP delta with a hard floor at 0. Returns the actual delta
// applied — for positive deltas this equals `points`; for negative
// deltas it equals `points` if the user had enough XP, or `-currentXp`
// if the loss would have taken them below zero. Callers that write to
// xp_history should use the returned value so the audit trail matches
// the real change to `users.xp_points`.
//
// Wrapped in a transaction so the read+write is atomic — better-sqlite3
// nests transactions as SAVEPOINTs when called inside an outer one,
// which is the case for queue resolution and match resolution paths.
const addXpFlooredTx = db.transaction((id, points) => {
  if (points >= 0) {
    stmts.addXp.run(points, id);
    return points;
  }
  const user = stmts.findById.get(id);
  if (!user) return 0;
  const currentXp = user.xp_points || 0;
  const actualDelta = Math.max(points, -currentXp);
  if (actualDelta !== 0) {
    stmts.addXp.run(actualDelta, id);
  }
  return actualDelta;
});

const addEarningsTx = db.transaction((id, amountUsdc) => {
  const user = stmts.findById.get(id);
  if (!user) throw new Error('User not found');
  const current = BigInt(user.total_earnings_usdc);
  const addition = BigInt(amountUsdc);
  db.prepare('UPDATE users SET total_earnings_usdc = ? WHERE id = ?').run(
    (current + addition).toString(),
    id,
  );
});

const addEnteredTx = db.transaction((id, amountUsdc) => {
  const user = stmts.findById.get(id);
  if (!user) throw new Error('User not found');
  const current = BigInt(user.total_entered_usdc);
  const addition = BigInt(amountUsdc);
  db.prepare('UPDATE users SET total_entered_usdc = ? WHERE id = ?').run(
    (current + addition).toString(),
    id,
  );
});

const userRepo = {
  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByDiscordId(discordId) {
    return stmts.findByDiscordId.get(discordId) || null;
  },

  create(discordId) {
    return stmts.create.get(discordId);
  },

  acceptTos(id) {
    return stmts.acceptTos.run(id);
  },

  setLanguage(discordId, lang) {
    return stmts.setLanguage.run(lang, discordId);
  },

  addXp(id, points) {
    return addXpFlooredTx(id, points);
  },

  addWin(id) {
    return stmts.addWin.run(id);
  },

  addLoss(id) {
    return stmts.addLoss.run(id);
  },

  addEarnings(id, amountUsdc) {
    return addEarningsTx(id, amountUsdc);
  },

  addEntered(id, amountUsdc) {
    return addEnteredTx(id, amountUsdc);
  },


  getXpLeaderboard(limit = 10) {
    return stmts.getXpLeaderboard.all(limit);
  },

  getEarningsLeaderboard(limit = 10) {
    return stmts.getEarningsLeaderboard.all(limit);
  },

  incrementCashWin(userId) { stmts.incrementCashWin.run(userId); },
  incrementCashLoss(userId) { stmts.incrementCashLoss.run(userId); },
};

module.exports = userRepo;

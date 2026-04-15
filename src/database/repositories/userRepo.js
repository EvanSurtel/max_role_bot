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
  acceptTos: db.prepare('UPDATE users SET accepted_tos = 1 WHERE id = ?'),
  setLanguage: db.prepare('UPDATE users SET language = ? WHERE discord_id = ?'),

  // Leaderboard stats
  addXp: db.prepare('UPDATE users SET xp_points = xp_points + ? WHERE id = ?'),
  addWin: db.prepare('UPDATE users SET total_wins = total_wins + 1 WHERE id = ?'),
  addLoss: db.prepare('UPDATE users SET total_losses = total_losses + 1 WHERE id = ?'),

  getXpLeaderboard: db.prepare(
    'SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0 ORDER BY xp_points DESC LIMIT ?'
  ),
  getEarningsLeaderboard: db.prepare(
    'SELECT * FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0 ORDER BY CAST(total_earnings_usdc AS INTEGER) DESC LIMIT ?'
  ),
};

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
    return stmts.addXp.run(points, id);
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
};

module.exports = userRepo;

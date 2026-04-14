const db = require('../db');

const stmts = {
  findById: db.prepare('SELECT * FROM challenges WHERE id = ?'),
  findByStatus: db.prepare('SELECT * FROM challenges WHERE status = ?'),
  findOpenChallenges: db.prepare("SELECT * FROM challenges WHERE status = 'open'"),
  create: db.prepare(`
    INSERT INTO challenges (type, creator_user_id, team_size, game_modes, series_length, entry_amount_usdc, total_pot_usdc, is_anonymous, expires_at)
    VALUES (@type, @creatorUserId, @teamSize, @gameModes, @seriesLength, @entryAmountUsdc, @totalPotUsdc, @isAnonymous, @expiresAt)
    RETURNING *
  `),
  updateStatus: db.prepare(`
    UPDATE challenges SET status = ?, updated_at = datetime('now') WHERE id = ?
  `),
  setAcceptor: db.prepare(`
    UPDATE challenges SET acceptor_user_id = ?, updated_at = datetime('now') WHERE id = ?
  `),
  setMessageId: db.prepare(`
    UPDATE challenges SET challenge_message_id = ?, challenge_channel_id = ?, updated_at = datetime('now') WHERE id = ?
  `),
};

const challengeRepo = {
  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByStatus(status) {
    return stmts.findByStatus.all(status);
  },

  findOpenChallenges() {
    return stmts.findOpenChallenges.all();
  },

  create({ type, creatorUserId, teamSize, gameModes, seriesLength, entryAmountUsdc, totalPotUsdc, isAnonymous, expiresAt }) {
    // Get next display number for this type (separate sequences for cash_match vs xp)
    const countRow = db.prepare('SELECT COUNT(*) as c FROM challenges WHERE type = ?').get(type);
    const displayNumber = (countRow?.c || 0) + 1;

    const result = stmts.create.get({
      type,
      creatorUserId,
      teamSize,
      gameModes,
      seriesLength,
      entryAmountUsdc: entryAmountUsdc || '0',
      totalPotUsdc: totalPotUsdc || '0',
      isAnonymous: isAnonymous != null ? isAnonymous : 1,
      expiresAt: expiresAt || null,
    });

    // Set display number
    if (result) {
      try {
        db.prepare('UPDATE challenges SET display_number = ? WHERE id = ?').run(displayNumber, result.id);
        result.display_number = displayNumber;
      } catch { /* column may not exist yet */ }
    }

    return result;
  },

  updateStatus(id, status) {
    return stmts.updateStatus.run(status, id);
  },

  setAcceptor(id, acceptorUserId) {
    return stmts.setAcceptor.run(acceptorUserId, id);
  },

  setMessageId(id, messageId, channelId) {
    return stmts.setMessageId.run(messageId, channelId, id);
  },

  /**
   * Atomically check that a challenge is in expectedStatus and update it to newStatus.
   * Returns true if the transition happened, false if the challenge was no longer in expectedStatus.
   * Uses BEGIN IMMEDIATE for serialized access.
   */
  atomicStatusTransition(id, expectedStatus, newStatus) {
    const tx = db.transaction(() => {
      const row = stmts.findById.get(id);
      if (!row || row.status !== expectedStatus) return false;
      stmts.updateStatus.run(newStatus, id);
      return true;
    });
    return tx.immediate();
  },

  update(id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;

    const setClauses = keys.map(k => {
      const col = k.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      return `${col} = @${k}`;
    });
    setClauses.push("updated_at = datetime('now')");

    const sql = `UPDATE challenges SET ${setClauses.join(', ')} WHERE id = @_id`;
    return db.prepare(sql).run({ ...fields, _id: id });
  },
};

module.exports = challengeRepo;

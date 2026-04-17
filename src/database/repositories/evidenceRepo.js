// Dispute evidence attachments storage.
const db = require('../db');

const stmts = {
  create: db.prepare(`
    INSERT INTO evidence (match_id, submitted_by, link, notes)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `),
  findByMatchId: db.prepare('SELECT * FROM evidence WHERE match_id = ? ORDER BY submitted_at'),
};

const evidenceRepo = {
  create(matchId, submittedByDiscordId, link, notes) {
    return stmts.create.get(matchId, submittedByDiscordId, link, notes || null);
  },

  findByMatchId(matchId) {
    return stmts.findByMatchId.all(matchId);
  },
};

module.exports = evidenceRepo;

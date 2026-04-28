// Tickets table CRUD. See migration 024_tickets.sql for schema.
const db = require('../db');

const stmts = {
  create: db.prepare(`
    INSERT INTO tickets (user_id, category, channel_id)
    VALUES (?, ?, ?)
    RETURNING *
  `),
  findById: db.prepare('SELECT * FROM tickets WHERE id = ?'),
  findByChannelId: db.prepare('SELECT * FROM tickets WHERE channel_id = ?'),
  findOpenByUser: db.prepare(
    "SELECT * FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC"
  ),
  findOpenByUserAndCategory: db.prepare(
    "SELECT * FROM tickets WHERE user_id = ? AND category = ? AND status = 'open' LIMIT 1"
  ),
  findAllOpen: db.prepare("SELECT * FROM tickets WHERE status = 'open'"),
  close: db.prepare(`
    UPDATE tickets
    SET status = ?, closed_at = datetime('now'), closed_by = ?
    WHERE id = ? AND status = 'open'
  `),
};

module.exports = {
  create({ userId, category, channelId }) {
    return stmts.create.get(userId, category, channelId);
  },

  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByChannelId(channelId) {
    return stmts.findByChannelId.get(channelId) || null;
  },

  findOpenByUser(userId) {
    return stmts.findOpenByUser.all(userId);
  },

  findOpenByUserAndCategory(userId, category) {
    return stmts.findOpenByUserAndCategory.get(userId, category) || null;
  },

  findAllOpen() {
    return stmts.findAllOpen.all();
  },

  /**
   * Mark a ticket closed. Atomic on (id, status='open') so a double-
   * click on the Close button doesn't run the close path twice.
   * @param {number} id
   * @param {'closed'|'auto_closed'} status
   * @param {string} closedByDiscordId  Discord ID of the closing user (or 'system' for auto-close)
   * @returns {boolean}  true if the row was updated, false if already closed
   */
  close(id, status, closedByDiscordId) {
    const result = stmts.close.run(status, closedByDiscordId, id);
    return result.changes > 0;
  },
};

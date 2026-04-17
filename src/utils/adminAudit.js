// Admin action audit log (dispute resolution, XP adjustments).
const db = require('../database/db');

const insertStmt = db.prepare(`
  INSERT INTO admin_actions (admin_discord_id, action_type, target_type, target_id, details)
  VALUES (?, ?, ?, ?, ?)
`);

/**
 * Log an admin action to the audit table.
 * @param {string} adminDiscordId
 * @param {string} actionType - e.g. 'resolve_dispute', 'cancel_match', 'force_refund'
 * @param {string} targetType - e.g. 'match', 'user', 'challenge'
 * @param {number} targetId
 * @param {object} [details] - Extra context (will be JSON-stringified)
 */
function logAdminAction(adminDiscordId, actionType, targetType, targetId, details = {}) {
  try {
    insertStmt.run(adminDiscordId, actionType, targetType, targetId, JSON.stringify(details));
  } catch (err) {
    console.error('[AdminAudit] Failed to log action:', err.message);
  }
}

module.exports = { logAdminAction };

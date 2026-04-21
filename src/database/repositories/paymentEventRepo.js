// payment_events ledger — append-only audit log for webhook events,
// with unique (provider, event_id) so we can dedupe replayed webhooks.

const db = require('../db');

/**
 * Record a payment event. Returns the inserted row on success, or null
 * if this (provider, event_id) pair was already recorded (duplicate).
 * Callers use the null-return as a cheap idempotency check: "if null,
 * we've already processed this event, skip."
 */
function record({ provider, eventId, eventType, orderId, status, payload }) {
  try {
    const result = db.prepare(`
      INSERT INTO payment_events (provider, event_id, event_type, order_id, status, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      provider,
      eventId,
      eventType || null,
      orderId || null,
      status || null,
      JSON.stringify(payload || {}),
    );
    return result;
  } catch (err) {
    // UNIQUE constraint on (provider, event_id) — duplicate replay.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

function findByEventId(provider, eventId) {
  return db.prepare(
    'SELECT * FROM payment_events WHERE provider = ? AND event_id = ?',
  ).get(provider, eventId);
}

module.exports = { record, findByEventId };

// DB-backed persistent timers — survives bot restarts.
const db = require('../database/db');

// In-memory map of active timeouts: timerId -> setTimeout handle
const activeTimeouts = new Map();

// Handler registry: type -> async function(referenceId)
const handlers = new Map();

// Prepared statements for timer operations
const stmts = {
  insert: db.prepare(`
    INSERT INTO timers (type, reference_id, expires_at)
    VALUES (@type, @referenceId, @expiresAt)
  `),
  markHandled: db.prepare('UPDATE timers SET handled = 1 WHERE id = ?'),
  markHandledByRef: db.prepare(
    'UPDATE timers SET handled = 1 WHERE type = ? AND reference_id = ? AND handled = 0'
  ),
  getPending: db.prepare('SELECT * FROM timers WHERE handled = 0'),
  getExpired: db.prepare(
    "SELECT * FROM timers WHERE handled = 0 AND expires_at <= datetime('now')"
  ),
  getByRef: db.prepare(
    'SELECT * FROM timers WHERE type = ? AND reference_id = ? AND handled = 0'
  ),
};

/**
 * Register a handler function for a given timer type.
 * @param {string} type - Timer type (e.g. 'challenge_expiry')
 * @param {function(number): Promise<void>} handler - Async handler that receives the reference_id
 */
function registerHandler(type, handler) {
  handlers.set(type, handler);
  console.log(`[Timer] Registered handler for type: ${type}`);
}

/**
 * Fire a timer: mark it as handled in DB and call the registered handler.
 * @param {object} timer - Timer row from DB
 */
async function fireTimer(timer) {
  try {
    // Mark as handled in DB first to avoid double-firing
    stmts.markHandled.run(timer.id);
    activeTimeouts.delete(timer.id);

    const handler = handlers.get(timer.type);
    if (handler) {
      console.log(`[Timer] Firing ${timer.type} for ref ${timer.reference_id} (timer #${timer.id})`);
      await handler(timer.reference_id);
    } else {
      console.warn(`[Timer] No handler registered for type: ${timer.type} (timer #${timer.id})`);
    }
  } catch (err) {
    console.error(`[Timer] Error firing timer #${timer.id} (${timer.type}):`, err);
  }
}

/**
 * Schedule a setTimeout for a timer and store the handle.
 * @param {object} timer - Timer row from DB
 * @param {number} delayMs - Delay in milliseconds
 */
function scheduleTimeout(timer, delayMs) {
  const handle = setTimeout(() => fireTimer(timer), delayMs);
  activeTimeouts.set(timer.id, handle);
}

/**
 * Create a new timer backed by the database.
 * @param {string} type - Timer type
 * @param {number} referenceId - The ID of the associated record
 * @param {number} durationMs - Duration in milliseconds from now
 * @returns {number} The timer row ID
 */
function createTimer(type, referenceId, durationMs) {
  const expiresAt = new Date(Date.now() + durationMs).toISOString();

  const result = stmts.insert.run({
    type,
    referenceId,
    expiresAt,
  });

  const timerId = result.lastInsertRowid;

  const timerRow = { id: timerId, type, reference_id: referenceId, expires_at: expiresAt };
  scheduleTimeout(timerRow, durationMs);

  console.log(`[Timer] Created #${timerId}: ${type} for ref ${referenceId}, expires ${expiresAt} (${durationMs}ms)`);
  return timerId;
}

/**
 * Cancel a timer by its ID.
 * @param {number} timerId - The timer row ID
 */
function cancelTimer(timerId) {
  // Clear the in-memory timeout
  const handle = activeTimeouts.get(timerId);
  if (handle) {
    clearTimeout(handle);
    activeTimeouts.delete(timerId);
  }

  // Mark as handled in DB
  stmts.markHandled.run(timerId);
  console.log(`[Timer] Cancelled #${timerId}`);
}

/**
 * Cancel all timers of a given type for a specific reference.
 * @param {string} type - Timer type
 * @param {number} referenceId - The reference ID
 */
function cancelTimersByReference(type, referenceId) {
  // Find all active timers for this type + reference
  const timers = stmts.getByRef.all(type, referenceId);

  for (const timer of timers) {
    const handle = activeTimeouts.get(timer.id);
    if (handle) {
      clearTimeout(handle);
      activeTimeouts.delete(timer.id);
    }
  }

  // Mark them all as handled in DB
  const result = stmts.markHandledByRef.run(type, referenceId);
  console.log(`[Timer] Cancelled ${result.changes} timer(s) of type ${type} for ref ${referenceId}`);
}

/**
 * Load all pending timers from DB and reschedule them.
 * Called on bot startup to survive restarts.
 */
function loadPendingTimers() {
  const pending = stmts.getPending.all();
  console.log(`[Timer] Loading ${pending.length} pending timer(s) from database...`);

  let fired = 0;
  let scheduled = 0;

  for (const timer of pending) {
    const expiresAt = new Date(timer.expires_at).getTime();
    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      // Already expired — fire immediately
      fired++;
      fireTimer(timer);
    } else {
      // Still in the future — schedule it
      scheduled++;
      scheduleTimeout(timer, remaining);
    }
  }

  console.log(`[Timer] Loaded: ${fired} fired immediately, ${scheduled} rescheduled`);
  return pending;
}

/**
 * Manually check for any unhandled expired timers.
 * Acts as a backup in case a setTimeout was missed (e.g. long GC pause).
 */
async function checkExpiredTimers() {
  const expired = stmts.getExpired.all();

  if (expired.length === 0) return;

  console.log(`[Timer] Found ${expired.length} expired unhandled timer(s), firing...`);

  for (const timer of expired) {
    // Skip if it's already being tracked by an active timeout
    // (it might fire on its own momentarily)
    if (activeTimeouts.has(timer.id)) {
      clearTimeout(activeTimeouts.get(timer.id));
      activeTimeouts.delete(timer.id);
    }
    await fireTimer(timer);
  }
}

module.exports = {
  createTimer,
  cancelTimer,
  cancelTimersByReference,
  loadPendingTimers,
  checkExpiredTimers,
  registerHandler,
};

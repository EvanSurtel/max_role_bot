// Periodic health checks + daily admin summary.
const { TIMERS } = require('../config/constants');
const db = require('../database/db');

let healthInterval = null;
const startTime = Date.now();

/**
 * Start periodic escrow health monitoring.
 */
function startHealthChecks(client) {
  if (healthInterval) return;

  console.log(`[Health] Starting health checks (every ${TIMERS.HEALTH_CHECK_INTERVAL / 1000}s)`);

  healthInterval = setInterval(() => {
    checkEscrowHealth(client).catch(err => {
      console.error('[Health] Error during health check:', err.message);
    });
  }, TIMERS.HEALTH_CHECK_INTERVAL);
}

function stopHealthChecks() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

/**
 * Periodic health check.
 * ETH balance check removed — CDP Smart Accounts + Coinbase Paymaster
 * handle gas; the escrow contract itself never needs ETH.
 */
async function checkEscrowHealth(_client) {
  // No-op: gasless via CDP Paymaster, no ETH balance required.
}

/**
 * Get a health summary object.
 */
function getHealthSummary() {
  const uptimeMs = Date.now() - startTime;
  const uptimeHours = (uptimeMs / 3600000).toFixed(1);

  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch { /* */ }

  let rpcOk = false;
  try {
    const { getProvider } = require('../base/connection');
    getProvider();
    rpcOk = true;
  } catch { /* */ }

  const pendingTxCount = db.prepare("SELECT COUNT(*) as c FROM pending_transactions WHERE status = 'pending'").get()?.c || 0;
  const activeMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('active', 'voting')").get()?.c || 0;

  return {
    uptime: `${uptimeHours}h`,
    dbConnected: dbOk,
    rpcConnected: rpcOk,
    matchCreationDisabled: false,
    pendingTransactions: pendingTxCount,
    activeMatches,
  };
}

/**
 * Post a daily summary to the admin alerts channel.
 */
async function postDailySummary(client) {
  const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
  if (!alertChannelId || !client) return;

  const ch = client.channels.cache.get(alertChannelId);
  if (!ch) return;

  const summary = getHealthSummary();

  await ch.send([
    '**Daily Health Summary**',
    `Uptime: ${summary.uptime}`,
    `DB: ${summary.dbConnected ? 'OK' : 'ERROR'}`,
    `Base RPC: ${summary.rpcConnected ? 'OK' : 'ERROR'}`,
    `Pending transactions: ${summary.pendingTransactions}`,
    `Active matches: ${summary.activeMatches}`,
  ].join('\n'));
}

/**
 * Whether new match creation is currently disabled.
 * Always false — CDP Paymaster handles gas; no ETH balance gating needed.
 */
function isMatchCreationDisabled() {
  return false;
}

module.exports = { startHealthChecks, stopHealthChecks, getHealthSummary, postDailySummary, isMatchCreationDisabled };

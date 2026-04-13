const { getEthBalance } = require('../base/walletManager');
const { ethers } = require('ethers');
const { ESCROW_SOL_WARNING, ESCROW_SOL_CRITICAL, TIMERS } = require('../config/constants');
const db = require('../database/db');

let healthInterval = null;
let lastWarningAt = 0;
let lastCriticalAt = 0;
let matchCreationDisabled = false;
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
 * Check escrow wallet SOL balance and alert if low.
 */
async function checkEscrowHealth(client) {
  const key = process.env.BOT_HOT_WALLET_PRIVATE_KEY;
  if (!key) return;

  let address;
  try {
    const wallet = new ethers.Wallet(key);
    address = wallet.address;
  } catch (err) {
    console.error('[Health] Invalid BOT_HOT_WALLET_PRIVATE_KEY:', err.message);
    return;
  }
  const ethBalWei = BigInt(await getEthBalance(address));
  const ethStr = ethers.formatEther(ethBalWei);
  const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
  const now = Date.now();

  // Critical: < 0.0001 ETH (~$0.25) — disable new matches
  const criticalWei = 100_000_000_000_000n; // 0.0001 ETH
  if (ethBalWei < criticalWei) {
    matchCreationDisabled = true;
    if (now - lastCriticalAt > 30 * 60 * 1000) {
      lastCriticalAt = now;
      console.error(`[Health] CRITICAL: Escrow ETH balance is ${ethStr}. New matches disabled.`);
      if (alertChannelId && client) {
        const ch = client.channels.cache.get(alertChannelId);
        if (ch) {
          await ch.send(`**CRITICAL: Escrow wallet ETH balance is ${ethStr} ETH.** New match creation has been disabled until this is resolved. Deposit ETH on Base to: \`${address}\``);
        }
      }
    }
    return;
  }

  if (matchCreationDisabled) {
    matchCreationDisabled = false;
    console.log('[Health] Escrow ETH recovered above critical threshold. Matches re-enabled.');
  }

  // Warning: < 0.001 ETH (~$2.50)
  const warningWei = 1_000_000_000_000_000n; // 0.001 ETH
  if (ethBalWei < warningWei) {
    if (now - lastWarningAt > 60 * 60 * 1000) {
      lastWarningAt = now;
      console.warn(`[Health] WARNING: Escrow ETH balance is ${ethStr}`);
      if (alertChannelId && client) {
        const ch = client.channels.cache.get(alertChannelId);
        if (ch) {
          await ch.send(`**Warning:** Escrow wallet ETH balance is low (${ethStr} ETH). Deposit ETH on Base to: \`${address}\``);
        }
      }
    }
  }
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

  let solanaOk = false;
  try {
    getConnection();
    solanaOk = true;
  } catch { /* */ }

  const pendingTxCount = db.prepare("SELECT COUNT(*) as c FROM pending_transactions WHERE status = 'pending'").get()?.c || 0;
  const activeMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('active', 'voting')").get()?.c || 0;

  return {
    uptime: `${uptimeHours}h`,
    dbConnected: dbOk,
    solanaConnected: solanaOk,
    matchCreationDisabled,
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

  let escrowEth = 'N/A';
  try {
    const key = process.env.BOT_HOT_WALLET_PRIVATE_KEY;
    if (key) {
      const w = new ethers.Wallet(key);
      const bal = await getEthBalance(w.address);
      escrowEth = `${ethers.formatEther(bal)} ETH`;
    }
  } catch { /* */ }

  await ch.send([
    '**Daily Health Summary**',
    `Uptime: ${summary.uptime}`,
    `DB: ${summary.dbConnected ? 'OK' : 'ERROR'}`,
    `Base RPC: ${summary.solanaConnected ? 'OK' : 'ERROR'}`,
    `Escrow ETH: ${escrowEth}`,
    `Match creation: ${summary.matchCreationDisabled ? 'DISABLED' : 'enabled'}`,
    `Pending transactions: ${summary.pendingTransactions}`,
    `Active matches: ${summary.activeMatches}`,
  ].join('\n'));
}

/**
 * Whether new match creation is currently disabled due to low escrow SOL.
 */
function isMatchCreationDisabled() {
  return matchCreationDisabled;
}

module.exports = { startHealthChecks, stopHealthChecks, getHealthSummary, postDailySummary, isMatchCreationDisabled };

const { getSolBalance } = require('../solana/walletManager');
const { getConnection } = require('../solana/connection');
const { ESCROW_SOL_WARNING, ESCROW_SOL_CRITICAL, LAMPORTS_PER_SOL, TIMERS } = require('../config/constants');
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
  const { Keypair } = require('@solana/web3.js');
  const secretKeyJson = process.env.ESCROW_WALLET_SECRET;
  if (!secretKeyJson) return;

  let escrowKeypair;
  try {
    escrowKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson)));
  } catch (err) {
    console.error('[Health] Invalid ESCROW_WALLET_SECRET:', err.message);
    return;
  }

  const address = escrowKeypair.publicKey.toBase58();
  const solBalance = BigInt(await getSolBalance(address));
  const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
  const now = Date.now();

  // Critical: < 0.01 SOL — disable new matches
  if (solBalance < BigInt(ESCROW_SOL_CRITICAL)) {
    matchCreationDisabled = true;
    if (now - lastCriticalAt > 30 * 60 * 1000) { // max once per 30 min
      lastCriticalAt = now;
      const solStr = (Number(solBalance) / LAMPORTS_PER_SOL).toFixed(4);
      console.error(`[Health] CRITICAL: Escrow SOL balance is ${solStr}. New matches disabled.`);
      if (alertChannelId && client) {
        const ch = client.channels.cache.get(alertChannelId);
        if (ch) {
          await ch.send(`**CRITICAL: Escrow wallet SOL balance is ${solStr} SOL.** New match creation has been disabled until this is resolved. Deposit SOL to: \`${address}\``);
        }
      }
    }
    return;
  }

  // If we were critical but now recovered
  if (matchCreationDisabled) {
    matchCreationDisabled = false;
    console.log('[Health] Escrow SOL recovered above critical threshold. Matches re-enabled.');
  }

  // Warning: < 0.05 SOL
  if (solBalance < BigInt(ESCROW_SOL_WARNING)) {
    if (now - lastWarningAt > 60 * 60 * 1000) { // max once per hour
      lastWarningAt = now;
      const solStr = (Number(solBalance) / LAMPORTS_PER_SOL).toFixed(4);
      console.warn(`[Health] WARNING: Escrow SOL balance is ${solStr}`);
      if (alertChannelId && client) {
        const ch = client.channels.cache.get(alertChannelId);
        if (ch) {
          await ch.send(`**Warning:** Escrow wallet SOL balance is low (${solStr} SOL). Deposit SOL to: \`${address}\``);
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

  let escrowSol = 'N/A';
  try {
    const { Keypair } = require('@solana/web3.js');
    const secretKeyJson = process.env.ESCROW_WALLET_SECRET;
    if (secretKeyJson) {
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson)));
      const bal = await getSolBalance(kp.publicKey.toBase58());
      escrowSol = `${(Number(bal) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
    }
  } catch { /* */ }

  await ch.send([
    '**Daily Health Summary**',
    `Uptime: ${summary.uptime}`,
    `DB: ${summary.dbConnected ? 'OK' : 'ERROR'}`,
    `Solana RPC: ${summary.solanaConnected ? 'OK' : 'ERROR'}`,
    `Escrow SOL: ${escrowSol}`,
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

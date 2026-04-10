// Admin transaction feed + per-user DM notifications.
//
// Every state change in the bot (deposit detected, wager created,
// match resolved, admin adjustment, etc.) calls postTransaction(),
// which posts a structured embed to TRANSACTIONS_CHANNEL_ID for
// admins to monitor.
//
// For PERSONAL money events (deposit, withdrawal, payout, refund)
// we ALSO try to DM the affected user in their saved language so
// they get a "Deposit successful" / "Withdrawal successful" message
// without having to open the wallet.

const { EmbedBuilder } = require('discord.js');
const { t } = require('../locales/i18n');

let discordClient = null;

function setClient(client) {
  discordClient = client;
  console.log('[TxFeed] Client initialized');

  // Verify the transactions channel is reachable on startup so we know
  // immediately if it's misconfigured. Logs success or the exact reason
  // it failed (wrong ID, missing permission, etc).
  const channelId = process.env.TRANSACTIONS_CHANNEL_ID;
  if (!channelId) {
    console.warn('[TxFeed] TRANSACTIONS_CHANNEL_ID is NOT set in .env — transactions feed disabled');
    return;
  }
  client.channels.fetch(channelId)
    .then(ch => {
      if (!ch) {
        console.error(`[TxFeed] TRANSACTIONS_CHANNEL_ID=${channelId} fetched but returned null`);
        return;
      }
      console.log(`[TxFeed] Verified transactions channel: #${ch.name} (${channelId})`);
    })
    .catch(err => {
      console.error(`[TxFeed] CANNOT REACH TRANSACTIONS_CHANNEL_ID=${channelId} — ${err.message}`);
      console.error('[TxFeed] Transactions feed will silently fail until this is fixed.');
      console.error('[TxFeed] Common causes: wrong channel ID, bot lacks View Channel permission, channel was deleted.');
    });
}

// Transaction types that warrant a DM to the affected user (anything
// where the user's own money moves in or out, OR XP/W-L/season events
// they would care about personally).
const DM_TYPES = new Set([
  'deposit',
  'withdrawal',
  'sol_withdrawal',
  'disbursement',
  'release',
  'refund',
  'escrow_in',
]);

const typeColors = {
  deposit: 0x2ecc71,
  withdrawal: 0xe74c3c,
  sol_withdrawal: 0xe74c3c,
  hold: 0xf39c12,
  release: 0x3498db,
  escrow_in: 0x9b59b6,
  gas_contribution: 0x95a5a6,
  disbursement: 0x2ecc71,
  challenge_created: 0x3498db,
  challenge_accepted: 0x2ecc71,
  challenge_cancelled: 0xe74c3c,
  challenge_expired: 0x95a5a6,
  teammate_accepted: 0x2ecc71,
  teammate_declined: 0xe74c3c,
  match_started: 0x9b59b6,
  match_report: 0xf39c12,
  match_resolved: 0x2ecc71,
  match_disputed: 0xe74c3c,
  match_no_winner: 0x95a5a6,
  xp_awarded: 0x5865f2,
  balance_mismatch: 0xe74c3c,
  admin_adjust_xp: 0xe67e22,
  admin_adjust_wl: 0xe67e22,
  admin_adjust_earnings: 0xe67e22,
  season_paused: 0xe67e22,
  season_resumed: 0x2ecc71,
  season_ended: 0xe67e22,
  user_registered: 0x3498db,
};

const typeIcons = {
  deposit: '📥',
  withdrawal: '📤',
  sol_withdrawal: '📤',
  hold: '🔒',
  release: '🔓',
  escrow_in: '➡️',
  gas_contribution: '⛽',
  disbursement: '💰',
  challenge_created: '📝',
  challenge_accepted: '✅',
  challenge_cancelled: '❌',
  challenge_expired: '⏱️',
  teammate_accepted: '🤝',
  teammate_declined: '👋',
  match_started: '🎮',
  match_report: '📊',
  match_resolved: '🏆',
  match_disputed: '⚠️',
  match_no_winner: '🚫',
  xp_awarded: '⭐',
  balance_mismatch: '🚨',
  admin_adjust_xp: '🛠️',
  admin_adjust_wl: '🛠️',
  admin_adjust_earnings: '🛠️',
  season_paused: '⏸️',
  season_resumed: '▶️',
  season_ended: '🏁',
  user_registered: '👤',
};

/**
 * Post a transaction to the admin transactions channel AND optionally
 * DM the affected user.
 *
 * Call this after every on-chain or DB transaction.
 */
async function postTransaction({ type, username, discordId, amount, currency, fromAddress, toAddress, signature, memo, challengeId }) {
  console.log(`[TxFeed] postTransaction(${type})${discordId ? ` user=${discordId}` : ''}${amount ? ` amount=${amount}` : ''}`);

  if (!discordClient) {
    console.warn('[TxFeed] Discord client not initialized — skipping postTransaction');
    return;
  }

  // ─── Post to the admin transactions channel ───────────────────
  await _postToFeedChannel({ type, username, discordId, amount, currency, fromAddress, toAddress, signature, memo, challengeId });

  // ─── DM the affected user (for personal money events) ────────
  if (DM_TYPES.has(type) && discordId) {
    await _dmUser(type, discordId, { amount, currency, signature, memo, toAddress });
  }
}

async function _postToFeedChannel({ type, username, discordId, amount, currency, fromAddress, toAddress, signature, memo, challengeId }) {
  const channelId = process.env.TRANSACTIONS_CHANNEL_ID;
  if (!channelId) {
    console.warn('[TxFeed] TRANSACTIONS_CHANNEL_ID not set — skipping channel post');
    return;
  }

  // Try the cache first; fall back to fetching the channel via the API.
  // The cache miss path was the bug: bots only cache channels they
  // actively receive events for, and the transactions channel rarely
  // gets user activity, so it falls out of cache after a restart.
  let channel = discordClient.channels.cache.get(channelId);
  if (!channel) {
    try {
      channel = await discordClient.channels.fetch(channelId);
    } catch (err) {
      console.error(`[TxFeed] Could not fetch transactions channel ${channelId}:`, err.message);
      return;
    }
  }
  if (!channel) {
    console.error(`[TxFeed] Channel ${channelId} not found after fetch`);
    return;
  }

  const color = typeColors[type] || 0x5865f2;
  const icon = typeIcons[type] || '🔄';

  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${type.toUpperCase().replace(/_/g, ' ')}`)
    .setColor(color)
    .setTimestamp();

  const fields = [];

  if (discordId) fields.push({ name: 'User', value: `<@${discordId}>${username ? ` (${username})` : ''}`, inline: true });
  if (amount && currency) fields.push({ name: 'Amount', value: `${amount} ${currency}`, inline: true });
  if (challengeId) fields.push({ name: 'Challenge', value: `#${challengeId}`, inline: true });
  if (fromAddress) fields.push({ name: 'From', value: `\`${fromAddress.slice(0, 8)}...${fromAddress.slice(-6)}\``, inline: true });
  if (toAddress) fields.push({ name: 'To', value: `\`${toAddress.slice(0, 8)}...${toAddress.slice(-6)}\``, inline: true });
  if (signature) fields.push({ name: 'Signature', value: `\`${signature.slice(0, 12)}...\``, inline: true });
  if (memo) fields.push({ name: 'Memo', value: memo });

  embed.addFields(fields);

  try {
    await channel.send({ embeds: [embed] });
    console.log(`[TxFeed] Posted ${type} embed to #${channel.name}`);
  } catch (err) {
    console.error(`[TxFeed] FAILED to send to #${channel.name} (${channelId}): ${err.message}`);
    console.error('[TxFeed] Bot likely lacks Send Messages or Embed Links permission on the transactions channel.');
  }
}

/**
 * DM the affected user about a transaction in their saved language.
 * Silently logs and continues if DMs are disabled or the user can't
 * be fetched — DMs are best-effort, not critical.
 */
async function _dmUser(type, discordId, info) {
  try {
    const userRepo = require('../database/repositories/userRepo');
    const user = userRepo.findByDiscordId(discordId);
    const lang = (user && user.language) || 'en';

    const key = `transaction_dm.${type}`;
    const content = t(key, lang, {
      amount: info.amount || '',
      currency: info.currency || '',
      to: info.toAddress ? `\`${info.toAddress}\`` : '',
      memo: info.memo || '',
    });

    // If the locale doesn't have this key, t() returns the key path.
    // Skip DMing in that case rather than sending the literal key.
    if (content === key) {
      return;
    }

    const discordUser = await discordClient.users.fetch(discordId);
    await discordUser.send({ content });
  } catch (err) {
    console.log(`[TxFeed] Could not DM user ${discordId} about ${type}: ${err.message}`);
  }
}

module.exports = { setClient, postTransaction };

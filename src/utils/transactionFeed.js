const { EmbedBuilder } = require('discord.js');

let discordClient = null;

function setClient(client) {
  discordClient = client;
}

/**
 * Post a transaction to the admin transactions channel.
 * Call this after every on-chain or DB transaction.
 */
async function postTransaction({ type, username, discordId, amount, currency, fromAddress, toAddress, signature, memo, challengeId }) {
  if (!discordClient) return;
  const channelId = process.env.TRANSACTIONS_CHANNEL_ID;
  if (!channelId) return;

  const channel = discordClient.channels.cache.get(channelId);
  if (!channel) return;

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

  const color = typeColors[type] || 0x5865f2;
  const icon = typeIcons[type] || '🔄';

  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${type.toUpperCase().replace('_', ' ')}`)
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
  } catch (err) {
    console.error('[TxFeed] Failed to post transaction:', err.message);
  }
}

module.exports = { setClient, postTransaction };

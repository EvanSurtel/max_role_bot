// Auto-deleting ephemeral reply helper.
//
// Discord ephemeral replies linger forever until the user dismisses them.
// We auto-delete them after 5 minutes to keep things tidy — except in the
// user's private wallet channel, where they may want to scroll back through
// recent history (transaction lists, copied addresses, etc.).

const AUTO_DELETE_MS = 5 * 60 * 1000; // 5 minutes

// Detect whether the interaction's channel is a wallet channel.
// Wallet channels are stored on the user row (`wallet_channel_id`) when the
// channel is created during onboarding.
function isWalletChannel(interaction) {
  if (!interaction || !interaction.channel || !interaction.channel.id) return false;
  try {
    const db = require('../database/db');
    const row = db.prepare('SELECT 1 FROM users WHERE wallet_channel_id = ? LIMIT 1').get(interaction.channel.id);
    return !!row;
  } catch {
    return false;
  }
}

// Schedule deletion of an ephemeral reply after AUTO_DELETE_MS.
// Silently ignores errors (interaction may already be expired).
function scheduleAutoDelete(interaction) {
  if (isWalletChannel(interaction)) return; // Wallet channels keep their messages
  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, AUTO_DELETE_MS);
}

/**
 * Send an ephemeral reply that auto-deletes after 5 minutes (except in wallet channels).
 *
 * Use this in place of `interaction.reply({ ephemeral: true })` when you want the
 * message to clean itself up.
 */
async function replyEphemeral(interaction, options) {
  const opts = typeof options === 'string' ? { content: options } : options;
  const reply = await interaction.reply({ ...opts, ephemeral: true });
  scheduleAutoDelete(interaction);
  return reply;
}

/**
 * Like `replyEphemeral` but for `editReply` (after a deferReply).
 */
async function editEphemeral(interaction, options) {
  const opts = typeof options === 'string' ? { content: options } : options;
  const reply = await interaction.editReply(opts);
  scheduleAutoDelete(interaction);
  return reply;
}

/**
 * Like `replyEphemeral` but for `followUp`.
 */
async function followUpEphemeral(interaction, options) {
  const opts = typeof options === 'string' ? { content: options } : options;
  const msg = await interaction.followUp({ ...opts, ephemeral: true });
  if (!isWalletChannel(interaction)) {
    setTimeout(() => { msg.delete().catch(() => {}); }, AUTO_DELETE_MS);
  }
  return msg;
}

module.exports = {
  replyEphemeral,
  editEphemeral,
  followUpEphemeral,
  scheduleAutoDelete,
  isWalletChannel,
  AUTO_DELETE_MS,
};

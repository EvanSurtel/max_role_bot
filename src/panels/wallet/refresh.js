// Wallet refresh handler — re-renders ephemeral with fresh balance.
const walletRepo = require('../../database/repositories/walletRepo');

/**
 * Handle the wallet refresh button. Rate-limited to 5/hour.
 * Re-renders the ephemeral wallet view in place with fresh balance data.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} user - DB user row.
 * @param {string} lang - Locale code.
 */
async function handleRefresh(interaction, user, lang) {
  const rateLimiter = require('../../utils/rateLimiter');
  const q = rateLimiter.checkQuota(user.discord_id, 'WALLET_REFRESH_PER_HOUR');
  if (q.blocked) {
    rateLimiter.trackBlock(user.discord_id, `wallet_refresh (${q.hits}/${q.max})`);
    const mins = Math.ceil(q.remainingSeconds / 60);
    return interaction.reply({
      content: `\u{1F504} Too many refreshes. Wallet balance auto-updates every 30s in the background. Try again in ${mins} min.`,
      ephemeral: true,
      _autoDeleteMs: 60_000,
    });
  }
  rateLimiter.recordQuota(user.discord_id, 'WALLET_REFRESH_PER_HOUR');

  await interaction.deferUpdate();

  const freshWallet = walletRepo.findByUserId(user.id);
  const { buildWalletView } = require('../walletPanelView');
  const view = buildWalletView(freshWallet, user, lang);
  return interaction.editReply(view);
}

module.exports = { handleRefresh };

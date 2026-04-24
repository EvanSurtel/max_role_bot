// "View My Wallet" button handler — opens wallet ephemeral.
const userRepo = require('../../database/repositories/userRepo');
const walletRepo = require('../../database/repositories/walletRepo');
const { t, langFor } = require('../../locales/i18n');

/**
 * Handle the "View My Wallet" button click from the public wallet channel.
 *
 * Sends an ephemeral message with the clicker's wallet view (balance,
 * address, action buttons) in their own language. Only the clicker sees it.
 * The ephemeral is persistent (does not auto-delete) so the user can use
 * the action buttons without the message disappearing.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleWalletViewOpen(interaction) {
  const lang = langFor(interaction);
  const { ensureReviewerUser } = require('../../utils/reviewerWhitelist');
  const { isDemoChannelContext } = require('../coinbaseReviewDemoPanel');

  // Demo channel fast path: any Discord user clicking View My Wallet
  // in the review demo channel gets auto-provisioned with a minimal
  // user row and flows straight into the self-custody setup link. No
  // COD form, no TOS click, no whitelist — the demo channel IS the
  // permission gate (server-side channel perms decide who can see it).
  // This lets CDP reviewers (or anyone else you invite) click through
  // the full onboarding + wallet + deposit flow end-to-end without
  // going through the real registration forms a COD player sees.
  let user = userRepo.findByDiscordId(interaction.user.id);
  if (!user && isDemoChannelContext(interaction)) {
    user = ensureReviewerUser(interaction.user.id, interaction.user.tag || interaction.user.username);
    console.log(`[ViewWallet] Auto-provisioned demo-channel user ${user.id} (discord=${interaction.user.id})`);
  }

  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    const { handleWalletPendingSetup } = require('./pendingSetup');
    return handleWalletPendingSetup(interaction, user);
  }

  const { buildWalletView } = require('../walletPanelView');
  const view = buildWalletView(wallet, user, lang);

  await interaction.reply({
    ...view,
    ephemeral: true,
    _persist: true,
  });
}

module.exports = { handleWalletViewOpen };

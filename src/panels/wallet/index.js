// Wallet panel — re-exports + main sub-button router.
// Backward-compatible: require('../panels/walletPanel') still works via
// the walletPanel.js redirect, and require('../panels/wallet') works directly.
const userRepo = require('../../database/repositories/userRepo');
const walletRepo = require('../../database/repositories/walletRepo');
const { t, langFor } = require('../../locales/i18n');

const { handleWalletViewOpen } = require('./viewOpen');
const { handleWithdrawModal, handleWithdrawConfirmButton } = require('./withdraw');
const { handleWithdrawSolModal, handleWithdrawSolMaxModal } = require('./withdrawEth');

/**
 * Handle wallet sub-buttons on the ephemeral wallet view (copy address,
 * withdraw, history, refresh). Always resolves the user via interaction.user.id
 * since there are no per-user wallet channels anymore -- the ephemeral is
 * already scoped to the clicker.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleWalletSubButton(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);

  // Withdrawal confirmation buttons
  if (id === 'wallet_wd_cancel' || id.startsWith('wallet_wd_usdc_') || id.startsWith('wallet_wd_sol_')) {
    return handleWithdrawConfirmButton(interaction);
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.user_not_found', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  if (id === 'wallet_deposit') {
    const { handleDeposit } = require('./deposit');
    return handleDeposit(interaction, user, wallet, lang);
  }

  // Deposit per-provider buttons (shown on the picker from wallet_deposit)
  if (id.startsWith('wallet_deposit_')) {
    const { handleDepositProvider } = require('./deposit');
    return handleDepositProvider(interaction, user, wallet, lang);
  }

  if (id === 'wallet_withdraw_menu') {
    const { handleWithdrawMenu } = require('./withdrawMenu');
    return handleWithdrawMenu(interaction, lang);
  }

  if (id === 'wallet_cashout') {
    const { handleCashOut } = require('./cashOut');
    return handleCashOut(interaction, user, wallet, lang);
  }

  // Cash-out per-provider buttons (shown on the picker from wallet_cashout)
  if (id.startsWith('wallet_cashout_')) {
    const { handleCashOutProvider } = require('./cashOut');
    return handleCashOutProvider(interaction, user, wallet, lang);
  }

  if (id === 'wallet_copy_address') {
    return interaction.reply({
      content: `\`\`\`\n${wallet.address}\n\`\`\``,
      ephemeral: true,
    });
  }

  // MoonPay was removed -- stale cached ephemeral stub
  if (id === 'wallet_moonpay_deposit' || id === 'wallet_moonpay_withdraw') {
    return interaction.reply({
      content: 'This feature is no longer available.',
      ephemeral: true,
    });
  }

  if (id === 'wallet_refresh') {
    const { handleRefresh } = require('./refresh');
    return handleRefresh(interaction, user, lang);
  }

  if (id === 'wallet_withdraw_sol') {
    const { showEthWithdrawOptions } = require('./withdrawEth');
    return showEthWithdrawOptions(interaction, wallet, lang);
  }

  if (id === 'wallet_sol_max') {
    const { showSolMaxModal } = require('./withdrawEth');
    return showSolMaxModal(interaction);
  }

  if (id === 'wallet_sol_custom') {
    const { showSolCustomModal } = require('./withdrawEth');
    return showSolCustomModal(interaction, lang);
  }

  if (id === 'wallet_withdraw') {
    const { showWithdrawModal } = require('./withdraw');
    return showWithdrawModal(interaction, lang);
  }

  if (id === 'wallet_history' || id.startsWith('wallet_history_page_')) {
    const { handleHistory } = require('./history');
    return handleHistory(interaction, user, lang);
  }
}

module.exports = {
  handleWalletViewOpen,
  handleWalletSubButton,
  handleWithdrawModal,
  handleWithdrawSolModal,
  handleWithdrawSolMaxModal,
  handleWithdrawConfirmButton,
};

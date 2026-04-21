// Wallet panel — re-exports + main sub-button router.
// Backward-compatible: require('../panels/walletPanel') still works via
// the walletPanel.js redirect, and require('../panels/wallet') works directly.
const userRepo = require('../../database/repositories/userRepo');
const walletRepo = require('../../database/repositories/walletRepo');
const { t, langFor } = require('../../locales/i18n');

const { handleWalletViewOpen } = require('./viewOpen');
const { handleWithdrawModal, handleWithdrawConfirmButton } = require('./withdraw');
const { handleWithdrawSolModal, handleWithdrawSolMaxModal } = require('./withdrawEth');
const { handleDepositAmountModal } = require('./deposit');
const { handleCashOutAmountModal } = require('./cashOut');

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

/**
 * Route payment amount-modal submits (deposit + cash-out). Called from
 * the interactionCreate modal dispatcher when customId matches.
 */
async function handleWalletAmountModal(interaction) {
  const id = interaction.customId;
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'User not found.', ephemeral: true });
  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) return interaction.reply({ content: 'Wallet not found.', ephemeral: true });
  const lang = langFor(interaction);

  if (id === 'wallet_deposit_amount_modal') return handleDepositAmountModal(interaction, user, wallet, lang);
  if (id === 'wallet_cashout_amount_modal') return handleCashOutAmountModal(interaction, user, wallet, lang);
  if (id === 'wallet_deposit_state_modal') {
    // Backfill state_code for pre-migration US users, then nudge them
    // back to the deposit flow.
    const US_STATES = new Set([
      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
      'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
      'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
      'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
    ]);
    const raw = interaction.fields.getTextInputValue('deposit_state_code').trim().toUpperCase().slice(0, 2);
    if (!US_STATES.has(raw)) {
      return interaction.reply({ content: `\`${raw}\` isn't a valid US state code.`, ephemeral: true });
    }
    const db = require('../../database/db');
    db.prepare('UPDATE users SET state_code = ? WHERE id = ?').run(raw, user.id);
    return interaction.reply({
      content: `State saved: **${raw}**. Click **Deposit USDC** again to continue.`,
      ephemeral: true,
    });
  }
}

module.exports = {
  handleWalletViewOpen,
  handleWalletSubButton,
  handleWalletAmountModal,
  handleWithdrawModal,
  handleWithdrawSolModal,
  handleWithdrawSolMaxModal,
  handleWithdrawConfirmButton,
};

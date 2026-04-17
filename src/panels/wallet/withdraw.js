// USDC withdrawal — modal, validation, confirmation, on-chain execution.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');
const userRepo = require('../../database/repositories/userRepo');
const walletRepo = require('../../database/repositories/walletRepo');
const transactionRepo = require('../../database/repositories/transactionRepo');
const walletManager = require('../../base/walletManager');
const transactionService = require('../../base/transactionService');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../../config/constants');
const { t, langFor } = require('../../locales/i18n');

/**
 * Show the USDC withdrawal modal (address + amount fields).
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} lang - Locale code.
 */
function showWithdrawModal(interaction, lang) {
  const modal = new ModalBuilder()
    .setCustomId('wallet_withdraw_modal')
    .setTitle(t('wallet.withdraw_modal_title_usdc', lang));

  const addressInput = new TextInputBuilder()
    .setCustomId('withdraw_address')
    .setLabel(t('wallet.withdraw_address_label', lang))
    .setPlaceholder(t('wallet.withdraw_address_placeholder', lang))
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(42)
    .setMaxLength(42);

  const amountInput = new TextInputBuilder()
    .setCustomId('withdraw_amount')
    .setLabel(t('wallet.withdraw_amount_label_usdc', lang))
    .setPlaceholder(t('wallet.withdraw_amount_placeholder_usdc', lang))
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(10);

  modal.addComponents(
    new ActionRowBuilder().addComponents(addressInput),
    new ActionRowBuilder().addComponents(amountInput),
  );

  return interaction.showModal(modal);
}

/**
 * Handle the USDC withdraw modal submission. Validates input then
 * shows a confirmation embed with the amount + destination address.
 * The actual transfer runs only after the user clicks "Yes, send it".
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleWithdrawModal(interaction) {
  const lang = langFor(interaction);
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();
  const amountStr = interaction.fields.getTextInputValue('withdraw_amount').trim();
  const amountUsdc = parseFloat(amountStr);

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: t('common.invalid_address', lang), ephemeral: true });
  }

  if (isNaN(amountUsdc) || amountUsdc <= 0) {
    return interaction.reply({ content: t('common.amount_must_be_positive', lang), ephemeral: true });
  }

  const minWithdraw = Number(process.env.MIN_WITHDRAWAL_USDC || 1);
  if (amountUsdc < minWithdraw) {
    return interaction.reply({
      content: `Minimum withdrawal is $${minWithdraw.toFixed(2)} USDC.`,
      ephemeral: true,
      _autoDeleteMs: 60_000,
    });
  }

  const amountSmallest = Math.round(amountUsdc * USDC_PER_UNIT);
  const availableSmallest = Number(wallet.balance_available);

  if (amountSmallest > availableSmallest) {
    const availableFormatted = (availableSmallest / USDC_PER_UNIT).toFixed(2);
    return interaction.reply({
      content: t('common.insufficient_balance', lang, { available: availableFormatted }),
      ephemeral: true,
    });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('wallet.withdraw_confirm_title', lang))
    .setColor(0xf39c12)
    .setDescription(t('wallet.withdraw_confirm_desc_usdc', lang, {
      amount: amountUsdc.toFixed(2),
      address,
    }));

  const fixedAmount = amountUsdc.toFixed(2);
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wallet_wd_usdc_${fixedAmount}_${address}`)
      .setLabel(t('wallet.withdraw_confirm_btn_yes', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wallet_wd_cancel')
      .setLabel(t('wallet.withdraw_confirm_btn_cancel', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({
    embeds: [confirmEmbed],
    components: [confirmRow],
    ephemeral: true,
  });
}

/**
 * Execute the on-chain USDC transfer. Called after the user confirms
 * the confirmation embed.
 *
 * @param {import('discord.js').ButtonInteraction} interaction - Already deferred/updated.
 * @param {object} user - DB user row.
 * @param {number} amountUsdc - Amount in human-readable USDC.
 * @param {string} address - Destination Base address.
 * @param {string} lang - Locale code.
 */
async function executeUsdcWithdraw(interaction, user, amountUsdc, address, lang) {
  const amountSmallest = Math.floor(amountUsdc * USDC_PER_UNIT);

  const rateLimiter = require('../../utils/rateLimiter');
  const guard = rateLimiter.guardOnchainAction(user.discord_id, 'WITHDRAW_PER_24H', 'Withdraw');
  if (guard.blocked) {
    return interaction.editReply({ content: guard.message, embeds: [], components: [] });
  }

  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({ content: t('common.please_wait', lang) });
  }

  try {
    const freshWallet = walletRepo.findByUserId(user.id);
    const freshAvailable = BigInt(freshWallet.balance_available);
    const amountBig = BigInt(amountSmallest);
    if (amountBig > freshAvailable) {
      walletRepo.releaseLock(user.id);
      const availableFormatted = (Number(freshAvailable) / USDC_PER_UNIT).toFixed(2);
      return interaction.editReply({ content: t('common.insufficient_balance', lang, { available: availableFormatted }) });
    }

    const pendingRow = transactionRepo.create({
      type: TRANSACTION_TYPE.WITHDRAWAL,
      userId: user.id,
      amountUsdc: amountSmallest.toString(),
      txHash: null,
      fromAddress: freshWallet.address,
      toAddress: address,
      status: 'pending_onchain',
      memo: `Withdrawal of $${amountUsdc} USDC \u2014 tx pending`,
    });

    const newAvailable = (freshAvailable - amountBig).toString();
    walletRepo.updateBalance(user.id, {
      balanceAvailable: newAvailable,
      balanceHeld: freshWallet.balance_held,
    });

    let signature;
    try {
      const result = await transactionService.transferUsdc(
        freshWallet.address,
        address,
        amountSmallest.toString(),
        { ownerRef: freshWallet.account_ref, smartRef: freshWallet.smart_account_ref },
      );
      signature = result.signature;
    } catch (txErr) {
      try {
        walletRepo.creditAvailable(user.id, amountSmallest.toString());
      } catch { /* best-effort */ }
      transactionRepo.updateStatusAndHash(pendingRow.id, 'failed', null, `Withdrawal failed: ${txErr.message}`);
      throw txErr;
    }

    transactionRepo.updateStatusAndHash(pendingRow.id, 'completed', signature, `Withdrawal of $${amountUsdc} USDC`);

    const { postTransaction } = require('../../utils/transactionFeed');
    postTransaction({ type: 'withdrawal', username: user.server_username, discordId: user.discord_id, amount: `$${amountUsdc.toFixed(2)}`, currency: 'USDC', fromAddress: freshWallet.address, toAddress: address, signature, memo: `Withdrawal of $${amountUsdc.toFixed(2)} USDC` });

    rateLimiter.recordOnchainAction(user.discord_id);
    rateLimiter.recordQuota(user.discord_id, 'WITHDRAW_PER_24H');

    walletRepo.releaseLock(user.id);
    return interaction.editReply({
      content: t('wallet.withdraw_success_usdc', lang, { amount: amountUsdc.toFixed(2), address, signature }),
      embeds: [],
      components: [],
    });
  } catch (err) {
    walletRepo.releaseLock(user.id);
    console.error('[Wallet] Withdrawal error:', err);
    return interaction.editReply({ content: t('wallet.withdraw_failed', lang), embeds: [], components: [] });
  }
}

/**
 * Handle Confirm / Cancel button clicks on the withdrawal confirmation
 * embed. Dispatches to USDC or ETH execution based on the customId.
 *
 * CustomId formats:
 *   wallet_wd_usdc_{amount}_{address}
 *   wallet_wd_sol_{amount}_{address}
 *   wallet_wd_cancel
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleWithdrawConfirmButton(interaction) {
  const lang = langFor(interaction);
  const id = interaction.customId;

  if (id === 'wallet_wd_cancel') {
    return interaction.update({
      content: t('wallet.withdraw_cancelled', lang),
      embeds: [],
      components: [],
    });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  // wallet_wd_<currency>_<amount>_<address>
  const afterPrefix = id.substring('wallet_wd_'.length);
  const firstUnd = afterPrefix.indexOf('_');
  const currency = afterPrefix.substring(0, firstUnd); // 'usdc' or 'sol'
  const rest = afterPrefix.substring(firstUnd + 1);
  const secondUnd = rest.indexOf('_');
  const amountStr = rest.substring(0, secondUnd);
  const address = rest.substring(secondUnd + 1);
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || !address) {
    return interaction.reply({ content: t('wallet.withdraw_failed', lang), ephemeral: true });
  }

  await interaction.update({
    content: t('wallet.withdraw_processing', lang),
    embeds: [],
    components: [],
  });

  if (currency === 'usdc') {
    return executeUsdcWithdraw(interaction, user, amount, address, lang);
  }
  if (currency === 'sol') {
    const { executeSolWithdraw } = require('./withdrawEth');
    return executeSolWithdraw(interaction, user, amount, address, lang);
  }
}

module.exports = { showWithdrawModal, handleWithdrawModal, handleWithdrawConfirmButton, executeUsdcWithdraw };

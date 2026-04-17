// ETH withdrawal — balance display, max/custom modals, on-chain execution.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const userRepo = require('../../database/repositories/userRepo');
const walletRepo = require('../../database/repositories/walletRepo');
const transactionRepo = require('../../database/repositories/transactionRepo');
const walletManager = require('../../base/walletManager');
const transactionService = require('../../base/transactionService');
const { t, langFor } = require('../../locales/i18n');

/**
 * Show ETH balance and max/custom withdrawal buttons.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} wallet - DB wallet row.
 * @param {string} lang - Locale code.
 */
async function showEthWithdrawOptions(interaction, wallet, lang) {
  const { ethers } = require('ethers');
  let ethDisplay = '0';
  let maxEth = '0';
  try {
    const ethBalWei = BigInt(await walletManager.getEthBalance(wallet.address));
    ethDisplay = ethers.formatEther(ethBalWei);
    const reserveWei = 100_000_000_000_000n; // 0.0001 ETH
    const maxWei = ethBalWei > reserveWei ? ethBalWei - reserveWei : 0n;
    maxEth = ethers.formatEther(maxWei);
  } catch { /* fallback to 0 */ }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_sol_max')
      .setLabel(`Send Max (${maxEth} ETH)`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wallet_sol_custom')
      .setLabel('Custom Amount')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({
    content: `**ETH Balance:** ${ethDisplay} ETH\n**Max withdrawable:** ${maxEth} ETH\n\nChoose an option:`,
    components: [row],
    ephemeral: true,
  });
}

/**
 * Show address-only modal for max ETH withdrawal.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
function showSolMaxModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('wallet_withdraw_sol_max_modal')
    .setTitle('Withdraw Max ETH');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('withdraw_address')
        .setLabel('Destination Base address')
        .setPlaceholder('0x...')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(42)
        .setMaxLength(42),
    ),
  );
  return interaction.showModal(modal);
}

/**
 * Show custom-amount ETH withdrawal modal (address + amount).
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} lang - Locale code.
 */
function showSolCustomModal(interaction, lang) {
  const modal = new ModalBuilder()
    .setCustomId('wallet_withdraw_sol_modal')
    .setTitle(t('wallet.withdraw_modal_title_sol', lang));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('withdraw_address')
        .setLabel(t('wallet.withdraw_address_label', lang))
        .setPlaceholder(t('wallet.withdraw_address_placeholder', lang))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(42)
        .setMaxLength(42),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('withdraw_amount')
        .setLabel(t('wallet.withdraw_amount_label_sol', lang))
        .setPlaceholder(t('wallet.withdraw_amount_placeholder_sol', lang))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(20),
    ),
  );
  return interaction.showModal(modal);
}

/**
 * Handle the custom-amount ETH withdraw modal. Validates input and
 * shows a confirmation embed.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleWithdrawSolModal(interaction) {
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
  const amountSol = parseFloat(amountStr);

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: t('common.invalid_address', lang), ephemeral: true });
  }

  if (isNaN(amountSol) || amountSol <= 0) {
    return interaction.reply({ content: t('common.amount_must_be_positive', lang), ephemeral: true });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('wallet.withdraw_confirm_title', lang))
    .setColor(0xf39c12)
    .setDescription(t('wallet.withdraw_confirm_desc_sol', lang, {
      amount: amountSol,
      address,
    }));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wallet_wd_sol_${amountSol}_${address}`)
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
 * Handle the "Send Max" ETH modal -- address-only, calculates max fresh.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleWithdrawSolMaxModal(interaction) {
  const lang = langFor(interaction);
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: t('common.invalid_address', lang), ephemeral: true });
  }

  const { ethers } = require('ethers');
  const ethBalWei = BigInt(await walletManager.getEthBalance(wallet.address));
  const reserveWei = 100_000_000_000_000n; // 0.0001 ETH
  const maxWei = ethBalWei > reserveWei ? ethBalWei - reserveWei : 0n;
  if (maxWei <= 0n) {
    return interaction.reply({
      content: 'No ETH available to withdraw after gas fees.',
      ephemeral: true,
    });
  }

  const amountSol = ethers.formatEther(maxWei);

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('wallet.withdraw_confirm_title', lang))
    .setColor(0xf39c12)
    .setDescription(t('wallet.withdraw_confirm_desc_sol', lang, {
      amount: amountSol,
      address,
    }));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wallet_wd_sol_${amountSol}_${address}`)
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
 * Execute the on-chain ETH transfer. Called after the user confirms.
 *
 * @param {import('discord.js').ButtonInteraction} interaction - Already deferred/updated.
 * @param {object} user - DB user row.
 * @param {number} amountSol - Amount in human-readable ETH.
 * @param {string} address - Destination Base address.
 * @param {string} lang - Locale code.
 */
async function executeSolWithdraw(interaction, user, amountSol, address, lang) {
  const { ethers } = require('ethers');
  const amountWei = ethers.parseEther(String(amountSol));

  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({
      content: t('common.please_wait', lang),
      embeds: [],
      components: [],
    });
  }

  try {
    const wallet = walletRepo.findByUserId(user.id);
    const ethBalWei = BigInt(await walletManager.getEthBalance(wallet.address));
    const reserveWei = 100_000_000_000_000n; // 0.0001 ETH
    if (amountWei > ethBalWei - reserveWei) {
      walletRepo.releaseLock(user.id);
      const availEth = ethers.formatEther(ethBalWei > reserveWei ? ethBalWei - reserveWei : 0n);
      return interaction.editReply({
        content: `Insufficient ETH. Available after gas reserve: **${availEth} ETH**.`,
        embeds: [],
        components: [],
      });
    }

    const { signature } = await transactionService.transferEth(
      wallet.address, address, amountWei,
    );

    transactionRepo.create({
      type: 'eth_withdrawal',
      userId: user.id,
      amountUsdc: '0',
      txHash: signature,
      fromAddress: wallet.address,
      toAddress: address,
      status: 'completed',
      memo: `ETH withdrawal: ${amountSol} ETH`,
    });

    const { postTransaction } = require('../../utils/transactionFeed');
    postTransaction({ type: 'eth_withdrawal', username: user.server_username, discordId: user.discord_id, amount: `${amountSol}`, currency: 'ETH', fromAddress: wallet.address, toAddress: address, signature, memo: `ETH withdrawal: ${amountSol} ETH` });

    walletRepo.releaseLock(user.id);
    return interaction.editReply({
      content: t('wallet.withdraw_success_sol', lang, { amount: amountSol, address, signature }),
      embeds: [],
      components: [],
    });
  } catch (err) {
    walletRepo.releaseLock(user.id);
    console.error('[Wallet] SOL withdrawal error:', err);
    return interaction.editReply({ content: t('wallet.withdraw_failed', lang), embeds: [], components: [] });
  }
}

module.exports = {
  showEthWithdrawOptions,
  showSolMaxModal,
  showSolCustomModal,
  handleWithdrawSolModal,
  handleWithdrawSolMaxModal,
  executeSolWithdraw,
};

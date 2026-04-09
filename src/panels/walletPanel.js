const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('../solana/walletManager');
const transactionService = require('../solana/transactionService');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../config/constants');
const { t, langFor } = require('../locales/i18n');

/**
 * Handle the "View My Wallet" button click from the public wallet channel.
 *
 * Sends an ephemeral message with the clicker's wallet view (balance,
 * address, action buttons) in their own language. Only the clicker sees it.
 * The ephemeral is persistent (does not auto-delete) so the user can use
 * the action buttons without the message disappearing.
 */
async function handleWalletViewOpen(interaction) {
  const lang = langFor(interaction);
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const { buildWalletView } = require('./walletPanelView');
  const view = buildWalletView(wallet, user, lang, solBalance);

  // _persist: true — the wallet ephemeral must not auto-delete so the user
  // can click Copy Address / Withdraw / History on it without losing it.
  await interaction.reply({
    ...view,
    ephemeral: true,
    _persist: true,
  });
}

/**
 * Handle wallet sub-buttons on the ephemeral wallet view (copy address,
 * withdraw, history, refresh). Always resolves the user via interaction.user.id
 * since there are no per-user wallet channels anymore — the ephemeral is
 * already scoped to the clicker.
 */
async function handleWalletSubButton(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.user_not_found', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  if (id === 'wallet_deposit') {
    return interaction.reply({
      content: t('wallet.deposit_info', lang, { address: wallet.solana_address }),
      ephemeral: true,
    });
  }

  if (id === 'wallet_copy_address') {
    // Wrap the address in a triple-backtick code block. On Discord desktop
    // this shows a built-in Copy button in the top-right of the block; on
    // mobile the address inside can still be long-pressed to copy.
    return interaction.reply({
      content: `\`\`\`\n${wallet.solana_address}\n\`\`\``,
      ephemeral: true,
    });
  }

  if (id === 'wallet_refresh') {
    // Re-render the ephemeral wallet view in place with fresh balance data.
    await interaction.deferUpdate();

    let solBalance = '0';
    try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

    // Re-fetch wallet to pick up any balance changes
    const freshWallet = walletRepo.findByUserId(user.id);
    const { buildWalletView } = require('./walletPanelView');
    const view = buildWalletView(freshWallet, user, lang, solBalance);
    return interaction.editReply(view);
  }

  if (id === 'wallet_withdraw_sol') {
    const modal = new ModalBuilder()
      .setCustomId('wallet_withdraw_sol_modal')
      .setTitle(t('wallet.withdraw_modal_title_sol', lang));

    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel(t('wallet.withdraw_address_label', lang))
      .setPlaceholder(t('wallet.withdraw_address_placeholder', lang))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);

    const amountInput = new TextInputBuilder()
      .setCustomId('withdraw_amount')
      .setLabel(t('wallet.withdraw_amount_label_sol', lang))
      .setPlaceholder(t('wallet.withdraw_amount_placeholder_sol', lang))
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

  if (id === 'wallet_withdraw') {
    const modal = new ModalBuilder()
      .setCustomId('wallet_withdraw_modal')
      .setTitle(t('wallet.withdraw_modal_title_usdc', lang));

    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel(t('wallet.withdraw_address_label', lang))
      .setPlaceholder(t('wallet.withdraw_address_placeholder', lang))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);

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

  if (id === 'wallet_history' || id.startsWith('wallet_history_page_')) {
    const transactions = transactionRepo.findByUserId(user.id).reverse(); // newest first
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(transactions.length / pageSize));

    let page = 0;
    if (id.startsWith('wallet_history_page_')) {
      page = parseInt(id.replace('wallet_history_page_', ''), 10) || 0;
    }
    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;

    if (transactions.length === 0) {
      return interaction.reply({ content: t('wallet.history_empty', lang), ephemeral: true });
    }

    const pageItems = transactions.slice(page * pageSize, (page + 1) * pageSize);
    const lines = pageItems.map((tx, i) => {
      const num = page * pageSize + i + 1;
      const amountUsdc = (Number(tx.amount_usdc) / USDC_PER_UNIT).toFixed(2);
      const date = tx.created_at ? tx.created_at.slice(0, 10) : 'N/A';
      const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' || tx.type === 'sol_withdrawal' ? '📤' : '🔄';
      // User-friendly translated label, e.g. "escrow_in" → "Match Entry"
      const typeLabel = t(`tx_type.${tx.type}`, lang);
      return `${num}. ${icon} **${typeLabel}** — $${amountUsdc} USDC — ${date}`;
    });

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wallet_history_page_${page - 1}`)
        .setLabel(t('common.previous', lang))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`wallet_history_page_${page + 1}`)
        .setLabel(t('common.next', lang))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    );

    const header = `**${t('wallet.history_title', lang)}** (${t('wallet.history_page', lang, { page: page + 1, total: totalPages, count: transactions.length })})`;
    const content = `${header}\n\n${lines.join('\n')}`;

    if (id === 'wallet_history') {
      return interaction.reply({ content, components: [navRow], ephemeral: true });
    } else {
      return interaction.update({ content, components: [navRow] });
    }
  }
}

/**
 * Handle the USDC withdraw modal submission.
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

  const amountSmallest = Math.floor(amountUsdc * USDC_PER_UNIT);
  const availableSmallest = Number(wallet.balance_available);

  if (amountSmallest > availableSmallest) {
    const availableFormatted = (availableSmallest / USDC_PER_UNIT).toFixed(2);
    return interaction.reply({
      content: t('common.insufficient_balance', lang, { available: availableFormatted }),
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({ content: t('common.please_wait', lang) });
  }

  try {
    const freshWallet = walletRepo.findByUserId(user.id);
    const freshAvailable = Number(freshWallet.balance_available);
    if (amountSmallest > freshAvailable) {
      walletRepo.releaseLock(user.id);
      const availableFormatted = (freshAvailable / USDC_PER_UNIT).toFixed(2);
      return interaction.editReply({ content: t('common.insufficient_balance', lang, { available: availableFormatted }) });
    }

    const senderKeypair = walletManager.getKeypairFromEncrypted(
      freshWallet.encrypted_private_key,
      freshWallet.encryption_iv,
      freshWallet.encryption_tag,
      freshWallet.encryption_salt,
    );

    const { signature } = await transactionService.transferUsdc(
      senderKeypair,
      address,
      amountSmallest.toString(),
    );

    const newAvailable = (freshAvailable - amountSmallest).toString();
    walletRepo.updateBalance(user.id, {
      balanceAvailable: newAvailable,
      balanceHeld: freshWallet.balance_held,
    });

    transactionRepo.create({
      type: TRANSACTION_TYPE.WITHDRAWAL,
      userId: user.id,
      amountUsdc: amountSmallest.toString(),
      solanaTxSignature: signature,
      fromAddress: freshWallet.solana_address,
      toAddress: address,
      status: 'completed',
      memo: `Withdrawal of $${amountUsdc} USDC`,
    });

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({ type: 'withdrawal', username: user.server_username, discordId: user.discord_id, amount: `$${amountUsdc.toFixed(2)}`, currency: 'USDC', fromAddress: freshWallet.solana_address, toAddress: address, signature, memo: `Withdrawal of $${amountUsdc.toFixed(2)} USDC` });

    walletRepo.releaseLock(user.id);
    return interaction.editReply({
      content: t('wallet.withdraw_success_usdc', lang, { amount: amountUsdc.toFixed(2), address, signature }),
    });
  } catch (err) {
    walletRepo.releaseLock(user.id);
    console.error('[Wallet] Withdrawal error:', err);
    return interaction.editReply({ content: t('wallet.withdraw_failed', lang) });
  }
}

/**
 * Handle the SOL withdraw modal submission.
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

  const lamports = Math.floor(amountSol * 1_000_000_000);

  await interaction.deferReply({ ephemeral: true });

  try {
    const solBalance = Number(await walletManager.getSolBalance(wallet.solana_address));
    const reserveLamports = 5_000_000;
    if (lamports > solBalance - reserveLamports) {
      const availSol = ((solBalance - reserveLamports) / 1_000_000_000).toFixed(8);
      return interaction.editReply({
        content: t('common.insufficient_sol', lang, { available: availSol }),
      });
    }

    const senderKeypair = walletManager.getKeypairFromEncrypted(
      wallet.encrypted_private_key,
      wallet.encryption_iv,
      wallet.encryption_tag,
      wallet.encryption_salt,
    );

    const { signature } = await transactionService.transferSol(senderKeypair, address, lamports);

    transactionRepo.create({
      type: 'sol_withdrawal',
      userId: user.id,
      amountUsdc: '0',
      solanaTxSignature: signature,
      fromAddress: wallet.solana_address,
      toAddress: address,
      status: 'completed',
      memo: `SOL withdrawal: ${amountSol} SOL (${lamports} lamports)`,
    });

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({ type: 'sol_withdrawal', username: user.server_username, discordId: user.discord_id, amount: `${amountSol}`, currency: 'SOL', fromAddress: wallet.solana_address, toAddress: address, signature, memo: `SOL withdrawal: ${amountSol} SOL` });

    return interaction.editReply({
      content: t('wallet.withdraw_success_sol', lang, { amount: amountSol, address, signature }),
    });
  } catch (err) {
    console.error('[Wallet] SOL withdrawal error:', err);
    return interaction.editReply({ content: t('wallet.withdraw_failed', lang) });
  }
}

module.exports = { handleWalletViewOpen, handleWalletSubButton, handleWithdrawModal, handleWithdrawSolModal };

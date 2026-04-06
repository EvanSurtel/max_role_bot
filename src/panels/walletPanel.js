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
const { walletEmbed } = require('../utils/embeds');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../config/constants');

/**
 * Handle the "My Wallet" panel button click.
 * Shows wallet info with sub-action buttons.
 */
async function handleWalletButton(interaction) {
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({
      content: 'You need to complete onboarding first.',
      ephemeral: true,
    });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({
      content: 'Your wallet has not been set up yet. Please contact an administrator.',
      ephemeral: true,
    });
  }

  const embed = walletEmbed(wallet, interaction.user);
  // Show SOL balance too
  const solBalance = await walletManager.getSolBalance(wallet.solana_address).catch(() => '0');
  const solFormatted = (Number(solBalance) / 1_000_000_000).toFixed(4);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_copy_address')
      .setLabel('Copy Address')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wallet_deposit')
      .setLabel('Deposit Info')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wallet_withdraw')
      .setLabel('Withdraw USDC')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('wallet_withdraw_sol')
      .setLabel('Withdraw SOL')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('wallet_history')
      .setLabel('History')
      .setStyle(ButtonStyle.Secondary),
  );

  embed.addFields({ name: 'SOL (for gas)', value: `${solFormatted} SOL`, inline: true });

  return interaction.reply({ embeds: [embed], components: [row1], ephemeral: true });
}

/**
 * Handle wallet sub-buttons (deposit, withdraw, history).
 */
async function handleWalletSubButton(interaction) {
  const id = interaction.customId;
  // Look up wallet owner by channel (admins can view other users' wallet channels)
  const db = require('../database/db');
  const channelOwner = db.prepare('SELECT * FROM users WHERE wallet_channel_id = ?').get(interaction.channel.id);
  const user = channelOwner || userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: 'User not found.', ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: 'Wallet not found.', ephemeral: true });
  }

  if (id === 'wallet_deposit') {
    return interaction.reply({
      content: `**Your Solana Deposit Address:**\n\n${wallet.solana_address}\n\n**To fund your wager wallet:**\n1. Send **USDC** (SPL token) to this address for wagers\n2. Send a small amount of **SOL** (~$0.50) for transaction fees — lasts ~100 wagers\n\nDeposits are detected automatically every 30 seconds.`,
      ephemeral: true,
    });
  }

  if (id === 'wallet_copy_address') {
    // Send ONLY the address as a plain message — easy to tap and copy on mobile
    return interaction.reply({
      content: wallet.solana_address,
      ephemeral: true,
    });
  }

  if (id === 'wallet_withdraw_sol') {
    const modal = new ModalBuilder()
      .setCustomId('wallet_withdraw_sol_modal')
      .setTitle('Withdraw SOL');

    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel('Destination Solana address')
      .setPlaceholder('e.g. 7xKXt...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);

    const amountInput = new TextInputBuilder()
      .setCustomId('withdraw_amount')
      .setLabel('Amount in SOL (e.g. 0.5)')
      .setPlaceholder('e.g. 0.5')
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
      .setTitle('Withdraw USDC');

    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel('Destination Solana address')
      .setPlaceholder('e.g. 7xKXt...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);

    const amountInput = new TextInputBuilder()
      .setCustomId('withdraw_amount')
      .setLabel('Amount in USDC (e.g. 10.50)')
      .setPlaceholder('e.g. 10.50')
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
      return interaction.reply({ content: 'No transactions found.', ephemeral: true });
    }

    const pageItems = transactions.slice(page * pageSize, (page + 1) * pageSize);
    const lines = pageItems.map((tx, i) => {
      const num = page * pageSize + i + 1;
      const amountUsdc = (Number(tx.amount_usdc) / USDC_PER_UNIT).toFixed(2);
      const date = tx.created_at ? tx.created_at.slice(0, 10) : 'N/A';
      const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
      return `${num}. ${icon} **${tx.type}** — $${amountUsdc} USDC — ${tx.status} — ${date}`;
    });

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wallet_history_page_${page - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`wallet_history_page_${page + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    );

    const content = `**Transactions (Page ${page + 1}/${totalPages} — ${transactions.length} total)**\n\n${lines.join('\n')}`;

    if (id === 'wallet_history') {
      return interaction.reply({ content, components: [navRow], ephemeral: true });
    } else {
      return interaction.update({ content, components: [navRow] });
    }
  }
}

/**
 * Handle the withdraw modal submission.
 */
async function handleWithdrawModal(interaction) {
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: 'You need to complete onboarding first.', ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: 'Wallet not found.', ephemeral: true });
  }

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();
  const amountStr = interaction.fields.getTextInputValue('withdraw_amount').trim();
  const amountUsdc = parseFloat(amountStr);

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: 'Invalid Solana address.', ephemeral: true });
  }

  if (isNaN(amountUsdc) || amountUsdc <= 0) {
    return interaction.reply({ content: 'Amount must be greater than 0.', ephemeral: true });
  }

  const amountSmallest = Math.floor(amountUsdc * USDC_PER_UNIT);
  const availableSmallest = Number(wallet.balance_available);

  if (amountSmallest > availableSmallest) {
    const availableFormatted = (availableSmallest / USDC_PER_UNIT).toFixed(2);
    return interaction.reply({
      content: `Insufficient balance. You have **$${availableFormatted} USDC** available.`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // Acquire wallet lock to prevent concurrent operations
  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({ content: 'Please wait, another transaction is in progress.' });
  }

  try {
    // Re-fetch wallet inside lock to get fresh balance
    const freshWallet = walletRepo.findByUserId(user.id);
    const freshAvailable = Number(freshWallet.balance_available);
    if (amountSmallest > freshAvailable) {
      walletRepo.releaseLock(user.id);
      return interaction.editReply({ content: 'Insufficient balance.' });
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

    walletRepo.releaseLock(user.id);
    return interaction.editReply({
      content: `**Withdrawal successful!**\n\nSent **$${amountUsdc.toFixed(2)} USDC** to \`${address}\`\nSignature: \`${signature}\``,
    });
  } catch (err) {
    walletRepo.releaseLock(user.id);
    console.error('[Wallet] Withdrawal error:', err);
    return interaction.editReply({ content: 'Withdrawal failed. Please try again later.' });
  }
}

/**
 * Handle the SOL withdraw modal submission.
 */
async function handleWithdrawSolModal(interaction) {
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: 'You need to complete onboarding first.', ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: 'Wallet not found.', ephemeral: true });
  }

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();
  const amountStr = interaction.fields.getTextInputValue('withdraw_amount').trim();
  const amountSol = parseFloat(amountStr);

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: 'Invalid Solana address.', ephemeral: true });
  }

  if (isNaN(amountSol) || amountSol <= 0) {
    return interaction.reply({ content: 'Amount must be greater than 0.', ephemeral: true });
  }

  const lamports = Math.floor(amountSol * 1_000_000_000);

  await interaction.deferReply({ ephemeral: true });

  try {
    // Check SOL balance
    const solBalance = Number(await walletManager.getSolBalance(wallet.solana_address));
    // Keep ~0.005 SOL for rent/fees
    const reserveLamports = 5_000_000;
    if (lamports > solBalance - reserveLamports) {
      const availSol = ((solBalance - reserveLamports) / 1_000_000_000).toFixed(4);
      return interaction.editReply({
        content: `Insufficient SOL. You have ~**${availSol} SOL** available after reserves.`,
      });
    }

    const senderKeypair = walletManager.getKeypairFromEncrypted(
      wallet.encrypted_private_key,
      wallet.encryption_iv,
      wallet.encryption_tag,
      wallet.encryption_salt,
    );

    const { signature } = await transactionService.transferSol(senderKeypair, address, lamports);

    return interaction.editReply({
      content: `**SOL Withdrawal successful!**\n\nSent **${amountSol} SOL** to \`${address}\`\nSignature: \`${signature}\``,
    });
  } catch (err) {
    console.error('[Wallet] SOL withdrawal error:', err);
    return interaction.editReply({ content: 'SOL withdrawal failed. Please try again later.' });
  }
}

module.exports = { handleWalletButton, handleWalletSubButton, handleWithdrawModal, handleWithdrawSolModal };

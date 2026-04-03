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

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_deposit')
      .setLabel('Deposit Address')
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

  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

/**
 * Handle wallet sub-buttons (deposit, withdraw, history).
 */
async function handleWalletSubButton(interaction) {
  const id = interaction.customId;
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: 'You need to complete onboarding first.', ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: 'Wallet not found.', ephemeral: true });
  }

  if (id === 'wallet_deposit') {
    return interaction.reply({
      content: [
        '**Your Solana Deposit Address:**',
        `\`\`\`${wallet.solana_address}\`\`\``,
        '',
        '**To fund your wager wallet:**',
        '1. Send **USDC** (SPL token) to this address for wagers',
        '2. Send a small amount of **SOL** (~$1) for transaction fees',
        '',
        'Deposits are detected automatically every 30 seconds.',
      ].join('\n'),
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

  if (id === 'wallet_history') {
    const transactions = transactionRepo.findByUserId(user.id);
    const recent = transactions.slice(-10).reverse();

    if (recent.length === 0) {
      return interaction.reply({ content: 'No transactions found.', ephemeral: true });
    }

    const lines = recent.map((tx, i) => {
      const amountUsdc = (Number(tx.amount_usdc) / USDC_PER_UNIT).toFixed(2);
      const date = tx.created_at ? tx.created_at.slice(0, 10) : 'N/A';
      const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
      return `${i + 1}. ${icon} **${tx.type}** — $${amountUsdc} USDC — ${tx.status} — ${date}`;
    });

    return interaction.reply({
      content: `**Recent Transactions:**\n\n${lines.join('\n')}`,
      ephemeral: true,
    });
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

  try {
    const senderKeypair = walletManager.getKeypairFromEncrypted(
      wallet.encrypted_private_key,
      wallet.encryption_iv,
      wallet.encryption_tag,
      wallet.encryption_salt,
    );

    const { signature } = await transactionService.transferUsdc(
      senderKeypair,
      address,
      amountSmallest.toString(),
    );

    const newAvailable = (availableSmallest - amountSmallest).toString();
    walletRepo.updateBalance(user.id, {
      balanceAvailable: newAvailable,
      balanceHeld: wallet.balance_held,
    });

    transactionRepo.create({
      type: TRANSACTION_TYPE.WITHDRAWAL,
      userId: user.id,
      amountUsdc: amountSmallest.toString(),
      solanaTxSignature: signature,
      fromAddress: wallet.solana_address,
      toAddress: address,
      status: 'completed',
      memo: `Withdrawal of $${amountUsdc} USDC`,
    });

    return interaction.editReply({
      content: `**Withdrawal successful!**\n\nSent **$${amountUsdc.toFixed(2)} USDC** to \`${address}\`\nSignature: \`${signature}\``,
    });
  } catch (err) {
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

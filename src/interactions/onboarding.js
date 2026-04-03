const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const walletManager = require('../solana/walletManager');
const channelService = require('../services/channelService');

/**
 * Handle button interactions for the onboarding TOS flow.
 * Buttons live on the static welcome panel in WELCOME_CHANNEL_ID.
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'tos_accept') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const discordId = interaction.user.id;

      let user = userRepo.findByDiscordId(discordId);
      if (!user) {
        user = userRepo.create(discordId);
      }

      if (user.accepted_tos === 1) {
        const walletChannelId = user.wallet_channel_id;
        const msg = walletChannelId
          ? `You're already registered! Check your wallet: <#${walletChannelId}>`
          : 'You\'re already registered!';
        return interaction.editReply({ content: msg });
      }

      userRepo.acceptTos(user.id);

      // Generate Solana wallet
      let wallet = walletRepo.findByUserId(user.id);
      if (!wallet) {
        const { address, encryptedPrivateKey, iv, tag, salt } = walletManager.generateWallet();
        wallet = walletRepo.create({
          userId: user.id,
          solanaAddress: address,
          encryptedPrivateKey,
          encryptionIv: iv,
          encryptionTag: tag,
          encryptionSalt: salt,
        });
      }

      // Create permanent wallet channel for this user
      const guild = interaction.guild;
      const walletChannel = await channelService.createPrivateChannel(
        guild,
        `wallet-${interaction.user.username}`,
        [discordId],
      );

      // Store wallet channel ID
      const db = require('../database/db');
      db.prepare('UPDATE users SET wallet_channel_id = ? WHERE id = ?').run(walletChannel.id, user.id);

      // Send wallet panel in the new channel
      await sendWalletPanel(walletChannel, wallet, interaction.user);

      await interaction.editReply({
        content: [
          '**Welcome! You are now registered.**',
          '',
          `Your wallet channel: <#${walletChannel.id}>`,
          'Head there to see your deposit address, balance, and withdraw.',
        ].join('\n'),
      });

    } catch (err) {
      console.error('[Onboarding] Error accepting TOS:', err);
      await interaction.editReply({
        content: 'Something went wrong during registration. Please contact an administrator.',
      });
    }
  }

  if (id === 'tos_decline') {
    return interaction.reply({
      content: 'You have declined the Terms of Service. You will not be able to participate in wagers.',
      ephemeral: true,
    });
  }

  // Wallet channel refresh button
  if (id === 'wallet_refresh') {
    return handleWalletRefresh(interaction);
  }
}

/**
 * Send the wallet panel embed + buttons in a wallet channel.
 */
async function sendWalletPanel(channel, wallet, discordUser) {
  const embed = new EmbedBuilder()
    .setTitle('Your Wallet')
    .setColor(0x2ecc71)
    .setDescription(
      [
        '**Deposit Address:**',
        `\`\`\`${wallet.solana_address}\`\`\``,
        '',
        '**To fund your wallet:**',
        '1. Send **USDC** (SPL token on Solana) to the address above for wagers',
        '2. Send a small amount of **SOL** (~$1) to the same address for transaction fees',
        '',
        'Deposits are detected automatically. Click **Refresh** to update your balance.',
      ].join('\n'),
    )
    .addFields(
      { name: 'USDC Balance', value: formatBalance(wallet.balance_available), inline: true },
      { name: 'Held in Wagers', value: formatBalance(wallet.balance_held), inline: true },
      { name: 'SOL (gas)', value: 'Click Refresh', inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_refresh')
      .setLabel('Refresh Balance')
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

  await channel.send({ embeds: [embed], components: [row] });
}

/**
 * Handle the refresh button in a wallet channel.
 */
async function handleWalletRefresh(interaction) {
  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({ content: 'User not found.', ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: 'Wallet not found.', ephemeral: true });
  }

  await interaction.deferUpdate();

  let solBalance = '0';
  try {
    solBalance = await walletManager.getSolBalance(wallet.solana_address);
  } catch { /* */ }

  const solFormatted = (Number(solBalance) / 1_000_000_000).toFixed(4);

  const embed = new EmbedBuilder()
    .setTitle('Your Wallet')
    .setColor(0x2ecc71)
    .setDescription(
      [
        '**Deposit Address:**',
        `\`\`\`${wallet.solana_address}\`\`\``,
        '',
        '**To fund your wallet:**',
        '1. Send **USDC** (SPL token on Solana) to the address above for wagers',
        '2. Send a small amount of **SOL** (~$1) to the same address for transaction fees',
        '',
        'Deposits are detected automatically. Click **Refresh** to update your balance.',
      ].join('\n'),
    )
    .addFields(
      { name: 'USDC Balance', value: formatBalance(wallet.balance_available), inline: true },
      { name: 'Held in Wagers', value: formatBalance(wallet.balance_held), inline: true },
      { name: 'SOL (gas)', value: `${solFormatted} SOL`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_refresh')
      .setLabel('Refresh Balance')
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

  await interaction.editReply({ embeds: [embed], components: [row] });
}

function formatBalance(amount) {
  const num = Number(amount);
  if (num === 0) return '$0.00 USDC';
  return `$${(num / 1_000_000).toFixed(2)} USDC`;
}

module.exports = { handleButton, sendWalletPanel };

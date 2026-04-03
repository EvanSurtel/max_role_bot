const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const walletManager = require('../solana/walletManager');
const channelService = require('../services/channelService');

/**
 * Handle button interactions for the onboarding TOS flow.
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
        await interaction.editReply({
          content: 'You are already onboarded! Check your wallet channel.',
        });
        return;
      }

      userRepo.acceptTos(user.id);

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

      // Create the user's permanent wallet channel
      const guild = interaction.guild;
      const walletChannel = await channelService.createPrivateChannel(
        guild,
        `wallet-${interaction.user.username}`,
        [discordId],
      );

      // Store the wallet channel ID on the user record
      const db = require('../database/db');
      db.prepare('UPDATE users SET wallet_channel_id = ? WHERE id = ?').run(walletChannel.id, user.id);

      // Send the wallet panel in the new channel
      await sendWalletPanel(walletChannel, wallet, interaction.user);

      await interaction.editReply({
        content: [
          '**Welcome! You have accepted the Terms of Service.**',
          '',
          `Your wallet channel has been created: <#${walletChannel.id}>`,
          '',
          'Head there to see your balance, deposit address, and withdraw.',
        ].join('\n'),
      });

      // Delete the onboarding channel after a short delay
      setTimeout(async () => {
        try {
          await interaction.channel.delete();
        } catch { /* */ }
      }, 15000);

    } catch (err) {
      console.error('[Onboarding] Error accepting TOS:', err);
      await interaction.editReply({
        content: 'Something went wrong during onboarding. Please contact an administrator.',
      });
    }
  }

  if (id === 'tos_decline') {
    await interaction.reply({
      content: 'You have declined the Terms of Service. You will not be able to participate in wagers. This channel will be deleted.',
      ephemeral: true,
    });

    setTimeout(async () => {
      try {
        await interaction.channel.delete();
      } catch { /* */ }
    }, 5000);
  }

  // Wallet channel buttons
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
        `**Deposit Address:**`,
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
 * Handle the refresh button in a wallet channel — update the balance embed.
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
        `**Deposit Address:**`,
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

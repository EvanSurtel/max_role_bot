const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const walletManager = require('../solana/walletManager');
const channelService = require('../services/channelService');

// Map server names to leaderboard regions
const SERVER_TO_REGION = {
  'na': 'na',
  'north america': 'na',
  'us': 'na',
  'us east': 'na',
  'us west': 'na',
  'canada': 'na',
  'latam': 'latam',
  'latin america': 'latam',
  'brazil': 'latam',
  'brasil': 'latam',
  'mexico': 'latam',
  'eu': 'eu',
  'europe': 'eu',
  'uk': 'eu',
  'germany': 'eu',
  'france': 'eu',
  'asia': 'asia',
  'japan': 'asia',
  'korea': 'asia',
  'india': 'asia',
  'sea': 'asia',
  'southeast asia': 'asia',
  'middle east': 'asia',
  'oceania': 'asia',
  'australia': 'asia',
};

/**
 * Handle button interactions for the onboarding TOS flow.
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  // Step 1: Accept TOS → show registration modal
  if (id === 'tos_accept') {
    const discordId = interaction.user.id;

    // Check if already registered
    const existingUser = userRepo.findByDiscordId(discordId);
    if (existingUser && existingUser.accepted_tos === 1) {
      const walletChannelId = existingUser.wallet_channel_id;
      const msg = walletChannelId
        ? `You're already registered! Check your wallet: <#${walletChannelId}>`
        : 'You\'re already registered!';
      return interaction.reply({ content: msg, ephemeral: true });
    }

    // Show registration modal
    const modal = new ModalBuilder()
      .setCustomId('registration_modal')
      .setTitle('Register');

    const usernameInput = new TextInputBuilder()
      .setCustomId('reg_username')
      .setLabel('In-game Username')
      .setPlaceholder('Your CODM username')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(30);

    const flagInput = new TextInputBuilder()
      .setCustomId('reg_flag')
      .setLabel('Country Flag')
      .setPlaceholder('e.g. 🇺🇸 or US')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(10);

    const serverInput = new TextInputBuilder()
      .setCustomId('reg_server')
      .setLabel('Server (NA, LATAM, EU, or Asia)')
      .setPlaceholder('e.g. NA')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(20);

    modal.addComponents(
      new ActionRowBuilder().addComponents(usernameInput),
      new ActionRowBuilder().addComponents(flagInput),
      new ActionRowBuilder().addComponents(serverInput),
    );

    return interaction.showModal(modal);
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
 * Handle the registration modal submission.
 */
async function handleRegistrationModal(interaction) {
  const discordId = interaction.user.id;

  const username = interaction.fields.getTextInputValue('reg_username').trim();
  const flag = interaction.fields.getTextInputValue('reg_flag').trim();
  const serverInput = interaction.fields.getTextInputValue('reg_server').trim().toLowerCase();

  // Map server to region
  const region = SERVER_TO_REGION[serverInput] || serverInput;
  const validRegions = ['na', 'latam', 'eu', 'asia'];
  if (!validRegions.includes(region)) {
    return interaction.reply({
      content: 'Invalid server. Please enter one of: **NA**, **LATAM**, **EU**, or **Asia**.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    let user = userRepo.findByDiscordId(discordId);
    if (!user) {
      user = userRepo.create(discordId);
    }

    if (user.accepted_tos === 1) {
      return interaction.editReply({ content: 'You\'re already registered!' });
    }

    userRepo.acceptTos(user.id);

    // Store username, flag, and region
    const db = require('../database/db');
    db.prepare('UPDATE users SET username = ?, flag = ?, region = ? WHERE id = ?')
      .run(username, flag, region, user.id);

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

    // Assign member role
    const guild = interaction.guild;
    const memberRoleId = process.env.MEMBER_ROLE_ID;
    if (memberRoleId) {
      try {
        const member = await guild.members.fetch(discordId);
        await member.roles.add(memberRoleId);
      } catch (err) {
        console.error(`[Onboarding] Failed to assign member role to ${discordId}:`, err.message);
      }
    }

    // Set nickname to "flag username" (e.g. "🇺🇸 PlayerOne")
    try {
      const member = await guild.members.fetch(discordId);
      await member.setNickname(`${flag} ${username}`);
    } catch (err) {
      // May fail if bot doesn't have permission or user is server owner
      console.warn(`[Onboarding] Could not set nickname for ${discordId}:`, err.message);
    }

    // Create permanent wallet channel
    const walletChannel = await channelService.createPrivateChannel(
      guild,
      `wallet-${username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      [discordId],
    );

    db.prepare('UPDATE users SET wallet_channel_id = ? WHERE id = ?').run(walletChannel.id, user.id);

    // Send wallet panel
    await sendWalletPanel(walletChannel, wallet, interaction.user);

    await interaction.editReply({
      content: [
        `**Welcome, ${flag} ${username}!**`,
        '',
        `Region: **${region.toUpperCase()}**`,
        `Your wallet channel: <#${walletChannel.id}>`,
        '',
        'Head there to see your deposit address and fund your wallet.',
      ].join('\n'),
    });

  } catch (err) {
    console.error('[Onboarding] Error during registration:', err);
    await interaction.editReply({
      content: 'Something went wrong during registration. Please contact an administrator.',
    });
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
  if (!user) return interaction.reply({ content: 'User not found.', ephemeral: true });

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) return interaction.reply({ content: 'Wallet not found.', ephemeral: true });

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

module.exports = { handleButton, handleRegistrationModal, sendWalletPanel };

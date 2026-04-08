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
const neatqueueService = require('../services/neatqueueService');

// Map server/region input to leaderboard region
const SERVER_TO_REGION = {
  'global': 'na', 'na': 'na', 'north america': 'na', 'us': 'na',
  'latam': 'latam', 'latin america': 'latam', 'brazil': 'latam', 'brasil': 'latam',
  'eu': 'eu', 'europe': 'eu',
  'garena': 'asia', 'asia': 'asia', 'sea': 'asia', 'korea': 'asia', 'japan': 'asia',
  'vietnam': 'asia', 'india': 'asia', 'middle east': 'asia', 'oceania': 'asia',
};

/**
 * Handle button interactions for onboarding.
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'tos_accept') {
    const discordId = interaction.user.id;

    // Check if already registered
    const existingUser = userRepo.findByDiscordId(discordId);
    if (existingUser && existingUser.accepted_tos === 1) {
      const r = await interaction.reply({ content: 'You\'re already registered!', ephemeral: true });
      setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 15000);
      return;
    }

    // Show registration modal
    const modal = new ModalBuilder()
      .setCustomId('registration_modal')
      .setTitle('Complete Your Registration');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_display_name')
          .setLabel('Server Display Name')
          .setPlaceholder('How you want to be known in this server')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(30),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_cod_ign')
          .setLabel('COD Mobile In-Game Name')
          .setPlaceholder('Your exact in-game name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(30),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_cod_uid')
          .setLabel('COD Mobile UID')
          .setPlaceholder('Numeric player ID from your CODM profile')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(5)
          .setMaxLength(20),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_server')
          .setLabel('Server/Region (Global, Garena, NA, EU, etc.)')
          .setPlaceholder('e.g. Global')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(20),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_country')
          .setLabel('Country (for flag display)')
          .setPlaceholder('e.g. US, BR, DE, PH or flag emoji')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(10),
      ),
    );

    return interaction.showModal(modal);
  }

  if (id === 'tos_decline') {
    const existingUser = userRepo.findByDiscordId(interaction.user.id);
    if (existingUser && existingUser.accepted_tos === 1) {
      await interaction.reply({
        content: 'You are already accepted and verified. You cannot decline after registering.',
        ephemeral: true,
      });
      setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 15000);
      return;
    }
    return interaction.reply({
      content: 'You must accept the Terms of Service to access this server. Click Accept when you\'re ready.',
      ephemeral: true,
    });
  }

  // Wallet channel buttons
  if (id === 'wallet_refresh') {
    return handleWalletRefresh(interaction);
  }
  if (id === 'wallet_lang') {
    return handleWalletLanguageButton(interaction);
  }
  if (id === 'wallet_lang_cancel') {
    return handleWalletLanguageCancel(interaction);
  }
}

/**
 * Handle the registration modal submission.
 */
async function handleRegistrationModal(interaction) {
  const discordId = interaction.user.id;

  const displayName = interaction.fields.getTextInputValue('reg_display_name').trim();
  const codIgn = interaction.fields.getTextInputValue('reg_cod_ign').trim();
  const codUid = interaction.fields.getTextInputValue('reg_cod_uid').trim();
  const serverInput = interaction.fields.getTextInputValue('reg_server').trim();
  const country = interaction.fields.getTextInputValue('reg_country').trim();

  // Validate CODM UID:
  // - Must be numeric
  // - 13-19 digits (standard CODM UID length)
  // - Must start with valid year prefix (67-75 for 2019-2027)
  if (!/^\d{13,19}$/.test(codUid)) {
    return interaction.reply({
      content: 'Invalid COD Mobile UID. It must be a 13-19 digit number.\n\n**How to find your UID:** Open CODM → tap your profile picture (top left) → your UID is the number below your avatar.',
      ephemeral: true,
    });
  }

  const uidPrefix = parseInt(codUid.substring(0, 2), 10);
  if (uidPrefix < 67 || uidPrefix > 75) {
    return interaction.reply({
      content: `Invalid COD Mobile UID. The UID \`${codUid}\` doesn't match a valid CODM account format.\n\n**How to find your UID:** Open CODM → tap your profile picture (top left) → your UID is the number below your avatar.`,
      ephemeral: true,
    });
  }

  // Check if UID is already registered by another user
  const db = require('../database/db');
  const existingUid = db.prepare('SELECT discord_id FROM users WHERE cod_uid = ? AND discord_id != ?').get(codUid, discordId);
  if (existingUid) {
    return interaction.reply({
      content: 'This COD Mobile UID is already registered to another account. Each UID can only be used once.',
      ephemeral: true,
    });
  }

  // Map server to leaderboard region
  const regionKey = serverInput.toLowerCase();
  const region = SERVER_TO_REGION[regionKey] || null;
  const validRegions = ['na', 'latam', 'eu', 'asia'];
  if (!region || !validRegions.includes(region)) {
    return interaction.reply({
      content: 'Invalid server/region. Please enter one of: **Global**, **Garena**, **NA**, **LATAM**, **EU**, or **Asia**.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Create or get user
    let user = userRepo.findByDiscordId(discordId);
    if (!user) {
      user = userRepo.create(discordId);
    }

    if (user.accepted_tos === 1) {
      return interaction.editReply({ content: 'You\'re already registered!' });
    }

    // Accept TOS and store profile
    userRepo.acceptTos(user.id);
    const db = require('../database/db');
    db.prepare(`
      UPDATE users SET server_username = ?, cod_ign = ?, cod_uid = ?, cod_server = ?, country_flag = ?, region = ?, tos_accepted_at = datetime('now')
      WHERE id = ?
    `).run(displayName, codIgn, codUid, serverInput, country, region, user.id);

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

    // Assign verified/member role
    const guild = interaction.guild;
    const memberRoleId = process.env.MEMBER_ROLE_ID;
    if (memberRoleId) {
      try {
        const member = await guild.members.fetch(discordId);
        await member.roles.add(memberRoleId);
      } catch (err) {
        console.error(`[Onboarding] Failed to assign member role:`, err.message);
      }
    }

    // Set nickname to display name
    try {
      const member = await guild.members.fetch(discordId);
      await member.setNickname(`${country} ${displayName} [500]`);
    } catch (err) {
      console.warn(`[Onboarding] Could not set nickname:`, err.message);
    }

    // Register IGN with NeatQueue
    if (neatqueueService.isConfigured()) {
      try {
        await syncIgnToNeatQueue(discordId, codIgn);
      } catch (err) {
        console.error(`[Onboarding] NeatQueue IGN sync failed:`, err.message);
      }
    }

    // Create permanent wallet channel — only user and admins can see (not staff)
    const walletChannelName = `wallet-${displayName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const walletCategoryId = process.env.WALLET_CATEGORY_ID || null;
    const walletChannel = await channelService.createPrivateChannel(
      guild,
      walletChannelName,
      [discordId],
      walletCategoryId,
      { adminOnly: true, readOnly: true },
    );

    db.prepare('UPDATE users SET wallet_channel_id = ? WHERE id = ?').run(walletChannel.id, user.id);

    // Send wallet panel in the wallet channel (in user's language if set)
    const freshUser = userRepo.findById(user.id);
    await sendWalletPanel(walletChannel, wallet, freshUser);

    // Send registration complete embed
    const completeEmbed = new EmbedBuilder()
      .setTitle('Registration Complete!')
      .setColor(0x2ecc71)
      .setDescription([
        `Welcome, **${displayName}**!`,
        '',
        'Your account has been set up:',
        '',
        `**Display Name:** ${displayName}`,
        `**COD Mobile IGN:** ${codIgn}`,
        `**COD Mobile UID:** ${codUid}`,
        `**Region:** ${serverInput}`,
        '',
        '**Your Wallet**',
        `A USDC wallet has been created for you. Check <#${walletChannel.id}> to view your deposit address and manage funds.`,
        '',
        '**Getting Started**',
        '1. Deposit **USDC** to your wallet address for wagers',
        '2. Deposit a tiny amount of **SOL** (~$0.50) for transaction fees — lasts ~100 wagers',
        '3. Head to the wager lobby channel',
        '4. Click **Create Wager** to challenge others or browse open challenges',
        '',
        'Good luck and have fun!',
      ].join('\n'));

    await interaction.editReply({ embeds: [completeEmbed] });

    // Notify admins in the admin alerts channel
    const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
    if (alertChannelId) {
      try {
        const alertChannel = interaction.client.channels.cache.get(alertChannelId);
        if (alertChannel) {
          const adminEmbed = new EmbedBuilder()
            .setTitle('New Registration')
            .setColor(0x3498db)
            .setDescription([
              `<@${discordId}> has registered.`,
              '',
              `**Display Name:** ${displayName}`,
              `**COD IGN:** ${codIgn}`,
              `**COD UID:** ${codUid}`,
              `**Server:** ${serverInput}`,
              `**Region:** ${region}`,
              `**Country:** ${country}`,
              `**Wallet:** \`${wallet.solana_address}\``,
            ].join('\n'))
            .setTimestamp();
          await alertChannel.send({ embeds: [adminEmbed] });
        }
      } catch (err) {
        console.error('[Onboarding] Failed to notify admins:', err.message);
      }
    }

    console.log(`[Onboarding] ${displayName} (${discordId}) registered: IGN=${codIgn}, UID=${codUid}, region=${region}`);

  } catch (err) {
    console.error('[Onboarding] Error during registration:', err);
    await interaction.editReply({
      content: 'Something went wrong during registration. Please contact an administrator.',
    });
  }
}

/**
 * Sync IGN to NeatQueue via their API.
 */
async function syncIgnToNeatQueue(discordUserId, ign) {
  const token = process.env.NEATQUEUE_API_TOKEN;
  if (!token) return;

  const channelId = process.env.NEATQUEUE_CHANNEL_ID;
  if (!channelId) return;

  const res = await fetch('https://api.neatqueue.com/api/v2/ign', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel_id: parseInt(channelId),
      user_id: parseInt(discordUserId),
      ign: ign,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[NeatQueue] IGN sync failed (${res.status}): ${body}`);
  } else {
    console.log(`[NeatQueue] IGN synced for ${discordUserId}: ${ign}`);
  }
}

/**
 * Send the wallet panel in a wallet channel.
 */
async function sendWalletPanel(channel, wallet, user = null) {
  const { buildWalletView } = require('../panels/walletPanelView');
  const lang = (user && user.language) || 'en';
  const view = buildWalletView(wallet, user, lang, null);
  await channel.send(view);
}

/**
 * Handle wallet refresh button — re-renders the wallet panel in place using
 * the channel owner's saved language.
 */
async function handleWalletRefresh(interaction) {
  const { buildWalletView } = require('../panels/walletPanelView');

  // Look up the wallet owner by channel ID (admins can see other users' wallet channels)
  const db = require('../database/db');
  const channelOwner = db.prepare('SELECT * FROM users WHERE wallet_channel_id = ?').get(interaction.channel.id);
  const user = channelOwner || userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'User not found.', ephemeral: true });

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) return interaction.reply({ content: 'Wallet not found.', ephemeral: true });

  await interaction.deferUpdate();

  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const lang = user.language || 'en';
  const view = buildWalletView(wallet, user, lang, solBalance);
  await interaction.editReply(view);
}

/**
 * Show the language picker — replaces the wallet view with a language select menu.
 */
async function handleWalletLanguageButton(interaction) {
  const { buildLanguagePickerView } = require('../panels/walletPanelView');

  const db = require('../database/db');
  const channelOwner = db.prepare('SELECT * FROM users WHERE wallet_channel_id = ?').get(interaction.channel.id);
  const user = channelOwner || userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'User not found.', ephemeral: true });

  const lang = user.language || 'en';
  const view = buildLanguagePickerView(lang);
  return interaction.update(view);
}

/**
 * Cancel the language picker and go back to the wallet view.
 */
async function handleWalletLanguageCancel(interaction) {
  const { buildWalletView } = require('../panels/walletPanelView');

  const db = require('../database/db');
  const channelOwner = db.prepare('SELECT * FROM users WHERE wallet_channel_id = ?').get(interaction.channel.id);
  const user = channelOwner || userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'User not found.', ephemeral: true });

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) return interaction.reply({ content: 'Wallet not found.', ephemeral: true });

  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const lang = user.language || 'en';
  const view = buildWalletView(wallet, user, lang, solBalance);
  return interaction.update(view);
}

/**
 * Save selected language and re-render the wallet panel in the new language.
 */
async function handleWalletLanguageSelect(interaction) {
  const { buildWalletView } = require('../panels/walletPanelView');
  const { SUPPORTED_LANGUAGES } = require('../locales');

  const newLang = interaction.values[0];
  if (!SUPPORTED_LANGUAGES[newLang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  // Save preference for the channel owner (admins viewing other users' channels
  // should not be able to change someone else's language)
  const db = require('../database/db');
  const channelOwner = db.prepare('SELECT * FROM users WHERE wallet_channel_id = ?').get(interaction.channel.id);
  if (!channelOwner) return interaction.reply({ content: 'Wallet channel owner not found.', ephemeral: true });
  if (channelOwner.discord_id !== interaction.user.id) {
    return interaction.reply({ content: 'Only the wallet owner can change the language.', ephemeral: true });
  }

  userRepo.setLanguage(channelOwner.discord_id, newLang);

  const wallet = walletRepo.findByUserId(channelOwner.id);
  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const freshUser = userRepo.findById(channelOwner.id);
  const view = buildWalletView(wallet, freshUser, newLang, solBalance);
  return interaction.update(view);
}

module.exports = {
  handleButton,
  handleRegistrationModal,
  sendWalletPanel,
  handleWalletRefresh,
  handleWalletLanguageButton,
  handleWalletLanguageCancel,
  handleWalletLanguageSelect,
};

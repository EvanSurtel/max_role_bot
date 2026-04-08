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
const { t, langFor } = require('../locales/i18n');

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
    const lang = langFor(interaction);

    // Check if already registered
    const existingUser = userRepo.findByDiscordId(discordId);
    if (existingUser && existingUser.accepted_tos === 1) {
      await interaction.reply({ content: t('onboarding.already_registered', lang), ephemeral: true });
      return;
    }

    // Show registration modal in the user's language
    const modal = new ModalBuilder()
      .setCustomId('registration_modal')
      .setTitle(t('onboarding.modal_title', lang));

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_display_name')
          .setLabel(t('onboarding.modal_display_name_label', lang))
          .setPlaceholder(t('onboarding.modal_display_name_placeholder', lang))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(30),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_cod_ign')
          .setLabel(t('onboarding.modal_cod_ign_label', lang))
          .setPlaceholder(t('onboarding.modal_cod_ign_placeholder', lang))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(30),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_cod_uid')
          .setLabel(t('onboarding.modal_cod_uid_label', lang))
          .setPlaceholder(t('onboarding.modal_cod_uid_placeholder', lang))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(5)
          .setMaxLength(20),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_server')
          .setLabel(t('onboarding.modal_server_label', lang))
          .setPlaceholder(t('onboarding.modal_server_placeholder', lang))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(20),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reg_country')
          .setLabel(t('onboarding.modal_country_label', lang))
          .setPlaceholder(t('onboarding.modal_country_placeholder', lang))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(10),
      ),
    );

    return interaction.showModal(modal);
  }

  if (id === 'tos_decline') {
    const lang = langFor(interaction);
    const existingUser = userRepo.findByDiscordId(interaction.user.id);
    if (existingUser && existingUser.accepted_tos === 1) {
      return interaction.reply({
        content: t('onboarding.cannot_decline_after', lang),
        ephemeral: true,
      });
    }
    return interaction.reply({
      content: t('onboarding.must_accept_tos', lang),
      ephemeral: true,
    });
  }

  // Wallet channel buttons (refresh only — language picker lives in welcome
  // panel and dedicated language channel, not here)
  if (id === 'wallet_refresh') {
    return handleWalletRefresh(interaction);
  }
}

/**
 * Handle the registration modal submission.
 */
async function handleRegistrationModal(interaction) {
  const discordId = interaction.user.id;
  const lang = langFor(interaction);

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
      content: t('onboarding.invalid_uid_format', lang),
      ephemeral: true,
    });
  }

  const uidPrefix = parseInt(codUid.substring(0, 2), 10);
  if (uidPrefix < 67 || uidPrefix > 75) {
    return interaction.reply({
      content: t('onboarding.invalid_uid_account', lang, { uid: codUid }),
      ephemeral: true,
    });
  }

  // Check if UID is already registered by another user
  const db = require('../database/db');
  const existingUid = db.prepare('SELECT discord_id FROM users WHERE cod_uid = ? AND discord_id != ?').get(codUid, discordId);
  if (existingUid) {
    return interaction.reply({
      content: t('onboarding.uid_already_registered', lang),
      ephemeral: true,
    });
  }

  // Map server to leaderboard region
  const regionKey = serverInput.toLowerCase();
  const region = SERVER_TO_REGION[regionKey] || null;
  const validRegions = ['na', 'latam', 'eu', 'asia'];
  if (!region || !validRegions.includes(region)) {
    return interaction.reply({
      content: t('onboarding.invalid_region', lang),
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
      return interaction.editReply({ content: t('onboarding.already_registered', lang) });
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

    // Send registration complete embed in the user's language
    const completeEmbed = new EmbedBuilder()
      .setTitle(t('onboarding.complete_title', lang))
      .setColor(0x2ecc71)
      .setDescription([
        t('onboarding.complete_welcome', lang, { name: displayName }),
        '',
        t('onboarding.complete_set_up', lang),
        '',
        `**${t('onboarding.complete_field_name', lang)}:** ${displayName}`,
        `**${t('onboarding.complete_field_ign', lang)}:** ${codIgn}`,
        `**${t('onboarding.complete_field_uid', lang)}:** ${codUid}`,
        `**${t('onboarding.complete_field_region', lang)}:** ${serverInput}`,
        '',
        `**${t('onboarding.complete_wallet_header', lang)}**`,
        t('onboarding.complete_wallet_text', lang, { channel: `<#${walletChannel.id}>` }),
        '',
        `**${t('onboarding.complete_started_header', lang)}**`,
        `1. ${t('onboarding.complete_started_1', lang)}`,
        `2. ${t('onboarding.complete_started_2', lang)}`,
        `3. ${t('onboarding.complete_started_3', lang)}`,
        `4. ${t('onboarding.complete_started_4', lang)}`,
        '',
        t('onboarding.complete_good_luck', lang),
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
      content: t('onboarding.registration_failed', lang),
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
  if (!user) return interaction.reply({ content: t('common.user_not_found', langFor(interaction)), ephemeral: true });

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) return interaction.reply({ content: t('common.wallet_not_found', langFor(interaction)), ephemeral: true });

  await interaction.deferUpdate();

  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const lang = user.language || 'en';
  const view = buildWalletView(wallet, user, lang, solBalance);
  await interaction.editReply(view);
}

/**
 * MASTER language switch — fired when a user picks a language from the
 * welcome channel's language picker (the dedicated message at the top of
 * the channel). Saves the user's bot-wide language preference and updates
 * BOTH the language picker AND the welcome/TOS panel below it to the new
 * language.
 */
async function handleWelcomeLanguageMaster(interaction) {
  const { SUPPORTED_LANGUAGES } = require('../locales');
  const { buildWelcomePanel, buildWelcomeLanguagePicker } = require('../panels/welcomePanel');

  const newLang = interaction.values[0];
  if (!SUPPORTED_LANGUAGES[newLang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  // Save the user's language preference, creating a user row if they don't have one yet
  // (they may not have accepted TOS yet but they can still pick a language).
  const discordId = interaction.user.id;
  let user = userRepo.findByDiscordId(discordId);
  if (!user) {
    user = userRepo.create(discordId);
  }
  userRepo.setLanguage(discordId, newLang);

  // Update the language picker message (the one the user clicked) in place
  await interaction.update(buildWelcomeLanguagePicker(newLang));

  // Then find the welcome/TOS panel below it (the next bot message in the
  // channel) and update it too — so users immediately see the TOS in their
  // chosen language.
  try {
    const channel = interaction.channel;
    const after = await channel.messages.fetch({ limit: 5, after: interaction.message.id });
    const welcomePanelMsg = after.find(m => m.author.id === interaction.client.user.id);
    if (welcomePanelMsg) {
      await welcomePanelMsg.edit(buildWelcomePanel(newLang));
    }
  } catch (err) {
    console.error('[Welcome] Failed to update welcome panel after language switch:', err.message);
  }

  // Send an ephemeral confirmation in the user's chosen language so they
  // know the master switch worked. Auto-deletes after 5 min.
  const langName = SUPPORTED_LANGUAGES[newLang].nativeName;
  await interaction.followUp({
    content: t('onboarding.language_saved', newLang, { language: langName }),
    ephemeral: true,
  });
}

/**
 * Handler for the dedicated language channel select menu. Same behaviour
 * as handleWelcomeLanguageMaster — saves the user's language preference
 * and re-renders the panel in the new language.
 */
async function handleLanguagePanelSelect(interaction) {
  const { SUPPORTED_LANGUAGES } = require('../locales');
  const { buildLanguagePanel } = require('../panels/languagePanel');

  const newLang = interaction.values[0];
  if (!SUPPORTED_LANGUAGES[newLang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  const discordId = interaction.user.id;
  let user = userRepo.findByDiscordId(discordId);
  if (!user) {
    user = userRepo.create(discordId);
  }
  userRepo.setLanguage(discordId, newLang);

  const view = buildLanguagePanel(newLang);
  await interaction.update(view);

  const langName = SUPPORTED_LANGUAGES[newLang].nativeName;
  await interaction.followUp({
    content: t('onboarding.language_saved', newLang, { language: langName }),
    ephemeral: true,
  });
}

module.exports = {
  handleButton,
  handleRegistrationModal,
  sendWalletPanel,
  handleWalletRefresh,
  handleWelcomeLanguageMaster,
  handleLanguagePanelSelect,
};

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
const walletManager = require('../base/walletManager');
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

// Flag emoji → ISO 3166-1 alpha-2 code (used for Changelly API)
const FLAG_TO_ISO = {
  '🇺🇸': 'US', '🇨🇦': 'CA', '🇬🇧': 'GB', '🇩🇪': 'DE', '🇫🇷': 'FR', '🇪🇸': 'ES',
  '🇮🇹': 'IT', '🇳🇱': 'NL', '🇵🇱': 'PL', '🇵🇹': 'PT', '🇸🇪': 'SE', '🇧🇪': 'BE',
  '🇦🇹': 'AT', '🇨🇭': 'CH', '🇮🇪': 'IE', '🇩🇰': 'DK', '🇫🇮': 'FI', '🇳🇴': 'NO',
  '🇬🇷': 'GR', '🇷🇴': 'RO', '🇨🇿': 'CZ', '🇭🇺': 'HU', '🇷🇺': 'RU', '🇺🇦': 'UA',
  '🇹🇷': 'TR', '🇧🇷': 'BR', '🇲🇽': 'MX', '🇦🇷': 'AR', '🇨🇴': 'CO', '🇨🇱': 'CL',
  '🇵🇪': 'PE', '🇻🇪': 'VE', '🇪🇨': 'EC', '🇨🇷': 'CR', '🇵🇦': 'PA', '🇬🇹': 'GT',
  '🇵🇷': 'PR', '🇩🇴': 'DO', '🇺🇾': 'UY', '🇧🇴': 'BO', '🇵🇾': 'PY', '🇭🇳': 'HN',
  '🇸🇻': 'SV', '🇳🇮': 'NI', '🇨🇺': 'CU', '🇮🇳': 'IN', '🇵🇭': 'PH', '🇮🇩': 'ID',
  '🇹🇭': 'TH', '🇻🇳': 'VN', '🇲🇾': 'MY', '🇸🇬': 'SG', '🇯🇵': 'JP', '🇰🇷': 'KR',
  '🇨🇳': 'CN', '🇹🇼': 'TW', '🇵🇰': 'PK', '🇧🇩': 'BD', '🇱🇰': 'LK', '🇳🇵': 'NP',
  '🇲🇲': 'MM', '🇰🇭': 'KH', '🇦🇺': 'AU', '🇳🇿': 'NZ', '🇸🇦': 'SA', '🇦🇪': 'AE',
  '🇪🇬': 'EG', '🇶🇦': 'QA', '🇰🇼': 'KW', '🇧🇭': 'BH', '🇴🇲': 'OM', '🇯🇴': 'JO',
  '🇱🇧': 'LB', '🇮🇶': 'IQ', '🇳🇬': 'NG', '🇿🇦': 'ZA', '🇰🇪': 'KE', '🇬🇭': 'GH',
  '🇲🇦': 'MA', '🇹🇳': 'TN', '🇩🇿': 'DZ',
};

const COUNTRY_FLAGS = {
  na: [
    { label: '🇺🇸 United States', value: '🇺🇸' },
    { label: '🇨🇦 Canada', value: '🇨🇦' },
  ],
  eu: [
    { label: '🇬🇧 United Kingdom', value: '🇬🇧' },
    { label: '🇩🇪 Germany', value: '🇩🇪' },
    { label: '🇫🇷 France', value: '🇫🇷' },
    { label: '🇪🇸 Spain', value: '🇪🇸' },
    { label: '🇮🇹 Italy', value: '🇮🇹' },
    { label: '🇳🇱 Netherlands', value: '🇳🇱' },
    { label: '🇵🇱 Poland', value: '🇵🇱' },
    { label: '🇵🇹 Portugal', value: '🇵🇹' },
    { label: '🇸🇪 Sweden', value: '🇸🇪' },
    { label: '🇧🇪 Belgium', value: '🇧🇪' },
    { label: '🇦🇹 Austria', value: '🇦🇹' },
    { label: '🇨🇭 Switzerland', value: '🇨🇭' },
    { label: '🇮🇪 Ireland', value: '🇮🇪' },
    { label: '🇩🇰 Denmark', value: '🇩🇰' },
    { label: '🇫🇮 Finland', value: '🇫🇮' },
    { label: '🇳🇴 Norway', value: '🇳🇴' },
    { label: '🇬🇷 Greece', value: '🇬🇷' },
    { label: '🇷🇴 Romania', value: '🇷🇴' },
    { label: '🇨🇿 Czech Republic', value: '🇨🇿' },
    { label: '🇭🇺 Hungary', value: '🇭🇺' },
    { label: '🇷🇺 Russia', value: '🇷🇺' },
    { label: '🇺🇦 Ukraine', value: '🇺🇦' },
    { label: '🇹🇷 Turkey', value: '🇹🇷' },
  ],
  latam: [
    { label: '🇧🇷 Brazil', value: '🇧🇷' },
    { label: '🇲🇽 Mexico', value: '🇲🇽' },
    { label: '🇦🇷 Argentina', value: '🇦🇷' },
    { label: '🇨🇴 Colombia', value: '🇨🇴' },
    { label: '🇨🇱 Chile', value: '🇨🇱' },
    { label: '🇵🇪 Peru', value: '🇵🇪' },
    { label: '🇻🇪 Venezuela', value: '🇻🇪' },
    { label: '🇪🇨 Ecuador', value: '🇪🇨' },
    { label: '🇨🇷 Costa Rica', value: '🇨🇷' },
    { label: '🇵🇦 Panama', value: '🇵🇦' },
    { label: '🇬🇹 Guatemala', value: '🇬🇹' },
    { label: '🇵🇷 Puerto Rico', value: '🇵🇷' },
    { label: '🇩🇴 Dominican Republic', value: '🇩🇴' },
    { label: '🇺🇾 Uruguay', value: '🇺🇾' },
    { label: '🇧🇴 Bolivia', value: '🇧🇴' },
    { label: '🇵🇾 Paraguay', value: '🇵🇾' },
    { label: '🇭🇳 Honduras', value: '🇭🇳' },
    { label: '🇸🇻 El Salvador', value: '🇸🇻' },
    { label: '🇳🇮 Nicaragua', value: '🇳🇮' },
    { label: '🇨🇺 Cuba', value: '🇨🇺' },
  ],
  asia: [
    { label: '🇮🇳 India', value: '🇮🇳' },
    { label: '🇵🇭 Philippines', value: '🇵🇭' },
    { label: '🇮🇩 Indonesia', value: '🇮🇩' },
    { label: '🇹🇭 Thailand', value: '🇹🇭' },
    { label: '🇻🇳 Vietnam', value: '🇻🇳' },
    { label: '🇲🇾 Malaysia', value: '🇲🇾' },
    { label: '🇸🇬 Singapore', value: '🇸🇬' },
    { label: '🇯🇵 Japan', value: '🇯🇵' },
    { label: '🇰🇷 South Korea', value: '🇰🇷' },
    { label: '🇨🇳 China', value: '🇨🇳' },
    { label: '🇹🇼 Taiwan', value: '🇹🇼' },
    { label: '🇵🇰 Pakistan', value: '🇵🇰' },
    { label: '🇧🇩 Bangladesh', value: '🇧🇩' },
    { label: '🇱🇰 Sri Lanka', value: '🇱🇰' },
    { label: '🇳🇵 Nepal', value: '🇳🇵' },
    { label: '🇲🇲 Myanmar', value: '🇲🇲' },
    { label: '🇰🇭 Cambodia', value: '🇰🇭' },
    { label: '🇦🇺 Australia', value: '🇦🇺' },
    { label: '🇳🇿 New Zealand', value: '🇳🇿' },
  ],
  mea: [
    { label: '🇸🇦 Saudi Arabia', value: '🇸🇦' },
    { label: '🇦🇪 UAE', value: '🇦🇪' },
    { label: '🇪🇬 Egypt', value: '🇪🇬' },
    { label: '🇶🇦 Qatar', value: '🇶🇦' },
    { label: '🇰🇼 Kuwait', value: '🇰🇼' },
    { label: '🇧🇭 Bahrain', value: '🇧🇭' },
    { label: '🇴🇲 Oman', value: '🇴🇲' },
    { label: '🇯🇴 Jordan', value: '🇯🇴' },
    { label: '🇱🇧 Lebanon', value: '🇱🇧' },
    { label: '🇮🇶 Iraq', value: '🇮🇶' },
    { label: '🇳🇬 Nigeria', value: '🇳🇬' },
    { label: '🇿🇦 South Africa', value: '🇿🇦' },
    { label: '🇰🇪 Kenya', value: '🇰🇪' },
    { label: '🇬🇭 Ghana', value: '🇬🇭' },
    { label: '🇲🇦 Morocco', value: '🇲🇦' },
    { label: '🇹🇳 Tunisia', value: '🇹🇳' },
    { label: '🇩🇿 Algeria', value: '🇩🇿' },
  ],
};

/**
 * Handle button interactions for onboarding.
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'tos_accept') {
    const discordId = interaction.user.id;
    const lang = langFor(interaction);

    const existingUser = userRepo.findByDiscordId(discordId);
    if (existingUser && existingUser.accepted_tos === 1) {
      return interaction.reply({ content: t('onboarding.already_registered', lang), ephemeral: true, _autoDeleteMs: 60_000 });
    }

    // Step 1: Region dropdown
    const { StringSelectMenuBuilder } = require('discord.js');
    const regionSelect = new StringSelectMenuBuilder()
      .setCustomId(`reg_region_select_${discordId}`)
      .setPlaceholder('Select your region')
      .addOptions([
        { label: 'NA (North America)', value: 'na' },
        { label: 'EU (Europe)', value: 'eu' },
        { label: 'LATAM (Latin America)', value: 'latam' },
        { label: 'Asia / Oceania', value: 'asia' },
        { label: 'Middle East / Africa', value: 'mea' },
      ]);

    return interaction.reply({
      content: '**Step 1/4 -- Select your region:**',
      components: [new ActionRowBuilder().addComponents(regionSelect)],
      ephemeral: true,
    });
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
 * Reads 3 fields (Display Name, COD IGN, COD UID) — region and country
 * were already collected via dropdowns and stored in global._pendingRegistrations.
 */
// Concurrency limiter on wallet generation. CDP API has rate limits;
// too many simultaneous getOrCreateAccount + getOrCreateSmartAccount
// calls can cause partial registrations (user row with TOS but no
// wallet). Cap at 3 concurrent registrations.
const MAX_CONCURRENT_REGISTRATIONS = 3;
let _activeRegistrations = 0;

async function handleRegistrationModal(interaction) {
  const discordId = interaction.user.id;
  const lang = langFor(interaction);

  // Retrieve region + country stored earlier by the dropdown steps
  const pending = global._pendingRegistrations?.get(discordId);
  if (!pending || !pending.region || !pending.country) {
    return interaction.reply({ content: 'Registration expired. Please click Accept again.', ephemeral: true });
  }

  const { region, country } = pending;
  global._pendingRegistrations.delete(discordId);

  const displayName = interaction.fields.getTextInputValue('reg_display_name').trim();
  const codIgn = interaction.fields.getTextInputValue('reg_cod_ign').trim();
  const codUid = interaction.fields.getTextInputValue('reg_cod_uid').trim();

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

  // --- Full registration (wallet, roles, NeatQueue, nickname, etc.) ---
  await interaction.deferReply({ ephemeral: true });

  try {
    let user = userRepo.findByDiscordId(discordId);
    if (!user) {
      user = userRepo.create(discordId);
    }

    if (user.accepted_tos === 1) {
      return interaction.editReply({ content: t('onboarding.already_registered', lang), components: [] });
    }

    userRepo.acceptTos(user.id);

    // Determine deposit region
    const GROUP_A_REGIONS = new Set(['na', 'eu']);
    const GROUP_A_COUNTRIES = new Set([
      '🇺🇸', '🇬🇧', '🇨🇦', '🇦🇺', '🇨🇭', '🇸🇬', '🇯🇵',
      '🇦🇹', '🇧🇪', '🇧🇬', '🇭🇷', '🇨🇾', '🇨🇿', '🇩🇰', '🇪🇪', '🇫🇮', '🇫🇷',
      '🇩🇪', '🇬🇷', '🇭🇺', '🇮🇪', '🇮🇹', '🇱🇻', '🇱🇹', '🇱🇺', '🇲🇹', '🇳🇱',
      '🇵🇱', '🇵🇹', '🇷🇴', '🇸🇰', '🇸🇮', '🇪🇸', '🇸🇪',
    ]);
    const depositRegion = (GROUP_A_REGIONS.has(region) || GROUP_A_COUNTRIES.has(country))
      ? 'GROUP_A'
      : 'GROUP_B';

    const regionLabel = { na: 'NA', eu: 'EU', latam: 'LATAM', asia: 'Asia', mea: 'MEA' }[region] || region.toUpperCase();

    const countryCode = FLAG_TO_ISO[country] || '';

    db.prepare(`
      UPDATE users SET server_username = ?, cod_ign = ?, cod_uid = ?, cod_server = ?, country_flag = ?, country_code = ?, region = ?, deposit_region = ?, tos_accepted_at = datetime('now')
      WHERE id = ?
    `).run(displayName, codIgn, codUid, regionLabel, country, countryCode, region, depositRegion, user.id);

    // Generate Base wallet (concurrency-limited to avoid CDP API overload)
    let wallet = walletRepo.findByUserId(user.id);
    if (!wallet) {
      if (_activeRegistrations >= MAX_CONCURRENT_REGISTRATIONS) {
        return interaction.editReply({
          content: 'Server is processing several registrations at once. Please try again in 30 seconds.',
          embeds: [], components: [],
        });
      }
      _activeRegistrations++;
      let walletData;
      try {
        walletData = await walletManager.generateWallet(user.id);
      } catch (walletErr) {
        _activeRegistrations--;
        console.error(`[Onboarding] Wallet generation failed for user ${user.id}:`, walletErr.message);
        return interaction.editReply({
          content: 'Wallet creation failed. Please try clicking Accept TOS again in a moment.',
          embeds: [], components: [],
        });
      }
      _activeRegistrations--;
      const { address, accountRef, smartAccountRef } = walletData;
      wallet = walletRepo.create({
        userId: user.id,
        address,
        accountRef,
        smartAccountRef,
      });

      let escrowApprovalFailed = false;
      try {
        const { approveEscrowForUser } = require('../base/escrowManager');
        await approveEscrowForUser(user.id);
      } catch (err) {
        escrowApprovalFailed = true;
        console.warn(`[Onboarding] Escrow approval failed for user ${user.id}:`, err.message);

        // Alert admins so they can monitor
        const approvalAlertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
        if (approvalAlertChannelId) {
          try {
            const alertCh = interaction.client.channels.cache.get(approvalAlertChannelId);
            if (alertCh) {
              const approvalAlertEmbed = new EmbedBuilder()
                .setTitle('Escrow Approval Failed During Onboarding')
                .setColor(0xe74c3c)
                .setDescription([
                  `<@${discordId}> registered successfully but USDC escrow approval failed.`,
                  '',
                  `**User ID:** ${user.id}`,
                  `**Wallet:** \`${wallet.address}\``,
                  `**Error:** ${err.message}`,
                  '',
                  'The approval will be retried automatically at first match entry (`depositToEscrow` checks allowance).',
                ].join('\n'))
                .setTimestamp();
              await alertCh.send({ embeds: [approvalAlertEmbed] });
            }
          } catch (alertErr) {
            console.error('[Onboarding] Failed to send escrow approval alert:', alertErr.message);
          }
        }
      }
    }

    // Assign member role
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

    // Set nickname
    try {
      const member = await guild.members.fetch(discordId);
      await member.setNickname(`${displayName} ${country} [500]`);
    } catch (err) {
      console.warn(`[Onboarding] Could not set nickname:`, err.message);
    }

    // NeatQueue sync
    if (neatqueueService.isConfigured()) {
      try {
        await syncIgnToNeatQueue(discordId, codIgn);
      } catch (err) {
        console.error(`[Onboarding] NeatQueue IGN sync failed:`, err.message);
      }
      try {
        await neatqueueService.setPoints(discordId, 500);
      } catch (err) {
        console.error(`[Onboarding] NeatQueue starting-points seed failed:`, err.message);
      }
    }

    // Rank role
    try {
      const { syncRank } = require('../utils/rankRoleSync');
      await syncRank(interaction.client, user.id);
    } catch (err) {
      console.warn(`[Onboarding] Rank role sync failed:`, err.message);
    }

    // Registration complete embed
    const walletChannelMention = process.env.WALLET_CHANNEL_ID
      ? `<#${process.env.WALLET_CHANNEL_ID}>`
      : '**#wallet**';
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
        `**${t('onboarding.complete_field_region', lang)}:** ${regionLabel}`,
        '',
        `**${t('onboarding.complete_wallet_header', lang)}**`,
        t('onboarding.complete_wallet_text', lang, { channel: walletChannelMention }),
        '',
        `**${t('onboarding.complete_started_header', lang)}**`,
        `1. ${t('onboarding.complete_started_1', lang)}`,
        `2. ${t('onboarding.complete_started_2', lang)}`,
        `3. ${t('onboarding.complete_started_3', lang)}`,
        `4. ${t('onboarding.complete_started_4', lang)}`,
        '',
        t('onboarding.complete_good_luck', lang),
      ].join('\n'));

    await interaction.editReply({ embeds: [completeEmbed], components: [], content: '' });

    // Warn user if escrow approval failed (non-blocking — approval retried at first match)
    if (escrowApprovalFailed) {
      try {
        await interaction.followUp({
          content: 'Your wallet was created but the USDC approval step had an issue. This will be retried automatically when you enter your first match. If you see errors when creating a match, try again.',
          ephemeral: true,
        });
      } catch (followUpErr) {
        console.warn('[Onboarding] Failed to send escrow approval warning to user:', followUpErr.message);
      }
    }

    // Admin notification
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
              `**Region:** ${regionLabel}`,
              `**Country:** ${country}`,
              `**Wallet:** \`${wallet.address}\``,
            ].join('\n'))
            .setTimestamp();
          await alertChannel.send({ embeds: [adminEmbed] });
        }
      } catch (err) {
        console.error('[Onboarding] Failed to notify admins:', err.message);
      }
    }

    console.log(`[Onboarding] ${displayName} (${discordId}) registered: IGN=${codIgn}, UID=${codUid}, region=${region}`);

    try {
      const { postTransaction } = require('../utils/transactionFeed');
      postTransaction({
        type: 'user_registered',
        username: displayName,
        discordId,
        memo: `${country} ${displayName} | IGN: ${codIgn} | UID: ${codUid} | Region: ${regionLabel} | Wallet: ${wallet.address}`,
      });
    } catch { /* */ }

  } catch (err) {
    console.error('[Onboarding] Error during registration:', err);
    await interaction.editReply({
      content: t('onboarding.registration_failed', lang),
      components: [],
    });
  }
}

/**
 * Handle the region dropdown selection (Step 1).
 * Stores the selected region in the pending cache and shows the country flag dropdown.
 */
async function handleRegionSelect(interaction) {
  const discordId = interaction.user.id;
  const region = interaction.values[0];

  // Initialize pending cache
  if (!global._pendingRegistrations) global._pendingRegistrations = new Map();

  // Store region; auto-expire after 5 minutes
  global._pendingRegistrations.set(discordId, { region });
  setTimeout(() => {
    const p = global._pendingRegistrations?.get(discordId);
    if (p && !p.country) global._pendingRegistrations.delete(discordId);
  }, 5 * 60 * 1000);

  // Build country flag dropdown filtered by region
  const flags = COUNTRY_FLAGS[region];
  if (!flags || flags.length === 0) {
    return interaction.update({ content: 'No countries found for that region. Please try again.', components: [] });
  }

  const { StringSelectMenuBuilder } = require('discord.js');
  const countrySelect = new StringSelectMenuBuilder()
    .setCustomId(`reg_country_select_${discordId}`)
    .setPlaceholder('Select your country')
    .addOptions(flags.slice(0, 25)); // Discord max 25 options

  const regionLabel = { na: 'NA', eu: 'EU', latam: 'LATAM', asia: 'Asia/Oceania', mea: 'Middle East/Africa' }[region] || region;

  return interaction.update({
    content: `**Step 2/4 -- Region: ${regionLabel}**\nSelect your country:`,
    components: [new ActionRowBuilder().addComponents(countrySelect)],
  });
}

/**
 * Handle the country flag dropdown selection (Step 2).
 * Stores the selected country flag in the pending cache and opens the
 * 3-field registration modal (Display Name, COD IGN, COD UID).
 */
async function handleCountrySelect(interaction) {
  const discordId = interaction.user.id;
  const country = interaction.values[0];

  const pending = global._pendingRegistrations?.get(discordId);
  if (!pending || !pending.region) {
    return interaction.reply({ content: 'Registration expired. Please click Accept again.', ephemeral: true });
  }

  // Store country in cache
  pending.country = country;

  // Auto-expire after 5 minutes
  setTimeout(() => global._pendingRegistrations.delete(discordId), 5 * 60 * 1000);

  // Open 3-field registration modal
  const modal = new ModalBuilder()
    .setCustomId('registration_modal')
    .setTitle('Register for Rank $');

  const displayNameInput = new TextInputBuilder()
    .setCustomId('reg_display_name')
    .setLabel('Display Name')
    .setPlaceholder('Your name in the server')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);

  const codIgnInput = new TextInputBuilder()
    .setCustomId('reg_cod_ign')
    .setLabel('COD Mobile IGN (In-Game Name)')
    .setPlaceholder('Your exact CODM username')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const codUidInput = new TextInputBuilder()
    .setCustomId('reg_cod_uid')
    .setLabel('COD Mobile UID (13-19 digits)')
    .setPlaceholder('e.g. 6742801234567890123')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(13)
    .setMaxLength(19);

  modal.addComponents(
    new ActionRowBuilder().addComponents(displayNameInput),
    new ActionRowBuilder().addComponents(codIgnInput),
    new ActionRowBuilder().addComponents(codUidInput),
  );

  return interaction.showModal(modal);
}

/**
 * Sync IGN to NeatQueue via their API.
 */
async function syncIgnToNeatQueue(discordUserId, ign) {
  const token = process.env.NEATQUEUE_API_TOKEN;
  if (!token) return;

  const channelId = process.env.NEATQUEUE_CHANNEL_ID;
  if (!channelId) return;

  // IMPORTANT: channel_id and user_id stay as STRINGS. Discord snowflakes
  // are 64-bit IDs that overflow JS Number precision (> 2^53), so parseInt
  // silently corrupts the last few digits of 18–19 digit IDs. Serialize as
  // strings so the full ID survives the round-trip to NeatQueue.
  const res = await fetch('https://api.neatqueue.com/api/v2/ign', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel_id: channelId,
      user_id: String(discordUserId),
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
  try { solBalance = await walletManager.getEthBalance(wallet.address); } catch { /* */ }

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
  return _handleAnyLanguageSelect(interaction, '[Welcome]');
}

/**
 * Handler for the dedicated language channel select menu.
 */
async function handleLanguagePanelSelect(interaction) {
  return _handleAnyLanguageSelect(interaction, '[LanguagePanel]');
}

/**
 * Shared logic for any language picker dropdown (welcome panel,
 * dedicated language channel, ephemeral button picker). Saves the
 * user's language to the DB, sends a confirmation, and then sends
 * a follow-up ephemeral with the panel from THIS channel re-rendered
 * in the new language (TOS for welcome, lobby for cash match, etc.).
 */
async function _handleAnyLanguageSelect(interaction, logPrefix) {
  const { SUPPORTED_LANGUAGES } = require('../locales');

  const newLang = interaction.values[0];
  if (!SUPPORTED_LANGUAGES[newLang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  // Save the user's language preference, creating a user row if they
  // don't have one yet (they may not have accepted TOS yet).
  const discordId = interaction.user.id;
  let user = userRepo.findByDiscordId(discordId);
  if (!user) {
    user = userRepo.create(discordId);
  }
  userRepo.setLanguage(discordId, newLang);

  const langName = SUPPORTED_LANGUAGES[newLang].nativeName;
  await interaction.reply({
    content: t('onboarding.language_saved', newLang, { language: langName }),
    ephemeral: true,
  });

  // Send an ephemeral copy of THIS channel's panel in the new language
  // with functional buttons — every channel handled by the dispatcher.
  try {
    const { sendEphemeralPanelForCurrentChannel } = require('../utils/ephemeralPanelDispatcher');
    await sendEphemeralPanelForCurrentChannel(interaction, newLang);
  } catch (err) {
    console.error(`${logPrefix} Failed to send ephemeral panel:`, err.message);
  }

  const { applyLanguageChange } = require('../utils/languageRefresh');
  applyLanguageChange(interaction.client, discordId, newLang).catch(err => {
    console.error(`${logPrefix} Background language refresh failed:`, err.message);
  });
}

module.exports = {
  handleButton,
  handleRegistrationModal,
  handleRegionSelect,
  handleCountrySelect,
  sendWalletPanel,
  handleWalletRefresh,
  handleWelcomeLanguageMaster,
  handleLanguagePanelSelect,
  FLAG_TO_ISO,
};

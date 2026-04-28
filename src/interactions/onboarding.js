// TOS acceptance + registration flow (region, country, COD UID, wallet creation).
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

    // Only block if the user is FULLY registered (accepted_tos AND
    // has a wallet row). A user with accepted_tos=1 but no wallet is
    // stuck — could be a leftover demo-channel auto-provision (now
    // removed), an incomplete prior registration, or a manually-
    // recovered row. Re-entering the registration flow is the
    // intended behaviour for those cases. Mirrors the same check
    // already applied at submit time below (~line 289).
    const existingUser = userRepo.findByDiscordId(discordId);
    if (existingUser && existingUser.accepted_tos === 1) {
      const existingWallet = walletRepo.findByUserId(existingUser.id);
      if (existingWallet) {
        // Fully registered. Idempotently re-grant the member role on
        // every TOS-accept click — covers the case where a moderator
        // (or another bot) wiped the role and the user is trying to
        // recover. Adding a role they already have is a no-op.
        try {
          const memberRoleId = process.env.MEMBER_ROLE_ID;
          if (memberRoleId && interaction.guild) {
            const member = await interaction.guild.members.fetch(discordId).catch(() => null);
            if (member && !member.roles.cache.has(memberRoleId)) {
              await member.roles.add(memberRoleId);
              console.log(`[Onboarding] Re-granted MEMBER role to already-registered user ${discordId}`);
            }
          }
        } catch (roleErr) {
          console.warn(`[Onboarding] Failed to re-grant member role for ${discordId}: ${roleErr.message}`);
        }
        return interaction.reply({ content: t('onboarding.already_registered', lang), ephemeral: true, _autoDeleteMs: 60_000 });
      }
      // accepted_tos=1 but no wallet — fall through to the region
      // dropdown so they can finish registration.
      console.log(`[Onboarding] User ${discordId} has accepted_tos=1 but no wallet — re-entering registration flow`);
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
  // state_code only present on the US-variant modal. Validated against
  // the ISO 3166-2 list so we don't pass "XX" through to Changelly and
  // get a generic "couldn't generate link" rejection.
  const US_STATES = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
  ]);
  let stateCode = null;
  try {
    const raw = interaction.fields.getTextInputValue('reg_state_code');
    if (raw) {
      const candidate = raw.trim().toUpperCase().slice(0, 2);
      if (!US_STATES.has(candidate)) {
        return interaction.reply({
          content: `\`${candidate}\` isn't a valid US state code. Please restart onboarding and enter a 2-letter code like NY, CA, TX.`,
          ephemeral: true,
        });
      }
      stateCode = candidate;
    }
  } catch { /* field not present on non-US modal */ }

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

  // --- Full registration (wallet, roles, nickname, etc.) ---
  await interaction.deferReply({ ephemeral: true });

  try {
    let user = userRepo.findByDiscordId(discordId);
    if (!user) {
      user = userRepo.create(discordId);
    }

    // Allow re-entry if TOS was accepted but wallet creation failed
    // previously (user is stuck with accepted_tos=1 but no wallet).
    // Only block if they're FULLY registered (TOS + wallet).
    const existingWallet = walletRepo.findByUserId(user.id);
    if (user.accepted_tos === 1 && existingWallet) {
      return interaction.editReply({ content: t('onboarding.already_registered', lang), components: [] });
    }

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
      UPDATE users SET server_username = ?, cod_ign = ?, cod_uid = ?, cod_server = ?, country_flag = ?, country_code = ?, state_code = ?, region = ?, deposit_region = ?, tos_accepted_at = datetime('now')
      WHERE id = ?
    `).run(displayName, codIgn, codUid, regionLabel, country, countryCode, stateCode, region, depositRegion, user.id);

    // Self-custody registration: no longer create a CDP Server Wallet
    // during onboarding. Instead, mint a one-time /setup link and the
    // user creates their own Coinbase Smart Wallet via passkey on the
    // web surface. The `wallets` row gets inserted later, by the
    // /api/internal/wallet/grant handler, once the user signs the
    // SpendPermission and the on-chain approveWithSignature lands.
    //
    // Why: the whole self-custody migration (and CDP approval) rests
    // on users owning their own wallets from day 0. Minting a custodial
    // CDP Server Wallet here and then asking them to "Upgrade" later
    // creates a two-tier fleet (legacy vs self-custody) and every new
    // user starts on the wrong side. Direct-to-self-custody at
    // registration puts every new user on the right path immediately.
    // TOS accepted upfront. Previously we deferred TOS until wallet
    // creation succeeded so a CDP failure wouldn't leave the user
    // stuck "registered but no wallet." That concern doesn't apply
    // to the self-custody path — nonce minting is a local DB insert
    // that effectively cannot fail. If the /setup web flow fails
    // later, they can be re-sent a setup link any time.
    userRepo.acceptTos(user.id);

    let setupUrl;
    try {
      const linkNonceService = require('../services/linkNonceService');
      setupUrl = linkNonceService.mintLink({
        userId: user.id,
        purpose: 'setup',
        // 2h TTL caps the window in which a leaked Discord DM link
        // could be redeemed by an attacker to bind their own Smart
        // Wallet to the victim's Rank $ account. If the user doesn't
        // complete setup in time, any wallet-panel click (View
        // Wallet, Deposit, etc.) re-mints a fresh link via
        // pendingSetup.js — so tightening the window has no UX cost.
        ttlSeconds: 2 * 60 * 60,
      });
    } catch (mintErr) {
      console.error(`[Onboarding] Setup link mint failed for user ${user.id}: ${mintErr.message}`);
      return interaction.editReply({
        content: 'Registration succeeded but we couldn\'t generate your wallet setup link. An admin will fix this shortly.',
        embeds: [], components: [],
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
        console.error(`[Onboarding] Failed to assign member role:`, err.message);
      }
    }

    // Set initial nickname matching the format used by nicknameUpdater
    // — keeps "Name 🇺🇸 [XP] [$Earnings]" consistent from registration
    // through every match resolve. New users start at [500] [$0.00].
    try {
      const member = await guild.members.fetch(discordId);
      await member.setNickname(`${displayName} ${country} [500] [$0.00]`);
    } catch (err) {
      console.warn(`[Onboarding] Could not set nickname:`, err.message);
    }

    // Rank role
    try {
      const { syncRank } = require('../utils/rankRoleSync');
      await syncRank(interaction.client, user.id);
    } catch (err) {
      console.warn(`[Onboarding] Rank role sync failed:`, err.message);
    }

    // Registration complete embed — guide them to /setup to create
    // their self-custody wallet.
    const completeEmbed = new EmbedBuilder()
      .setTitle(t('onboarding.complete_title', lang))
      .setColor(0x2ecc71)
      .setDescription([
        `👋 Welcome, **${displayName}**!`,
        '',
        '**You\'re registered — you can play free XP matches and the ranked queue right now.**',
        '',
        'Just want XP / ranked? You\'re done. Head to **#create-xp-match** or **#xp-match-queue** and play. **No wallet needed.**',
        '',
        '**Want to play cash matches too?** Set up your self-custody wallet (takes 30 seconds):',
        '',
        `🔐 **${setupUrl}**`,
        '',
        '• Your own crypto wallet on Base — only YOU can unlock it.',
        '• **Only you can confirm payments.** Rank $ has no way to move your funds without your permission.',
        '• You can do this any time — click **View My Wallet** in **#my-wallet** whenever you\'re ready.',
        '',
        '_Setup link valid for 2 hours and works once. If it expires, click **View My Wallet** for a fresh one._',
        '',
        `**${t('onboarding.complete_field_name', lang)}:** ${displayName}`,
        `**${t('onboarding.complete_field_ign', lang)}:** ${codIgn}`,
        `**${t('onboarding.complete_field_uid', lang)}:** ${codUid}`,
        `**${t('onboarding.complete_field_region', lang)}:** ${regionLabel}`,
      ].join('\n'));

    await interaction.editReply({ embeds: [completeEmbed], components: [], content: '' });

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
              `**Wallet:** _pending self-custody setup_`,
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
        memo: `${country} ${displayName} | IGN: ${codIgn} | UID: ${codUid} | Region: ${regionLabel} | Wallet: pending setup`,
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

  // Open registration modal. US users get a 4th field for their
  // ISO-3166-2 state code (required by Changelly + CDP when
  // country=US). Everyone else gets the standard 3 fields.
  const isUs = country === '🇺🇸';

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

  const rows = [
    new ActionRowBuilder().addComponents(displayNameInput),
    new ActionRowBuilder().addComponents(codIgnInput),
    new ActionRowBuilder().addComponents(codUidInput),
  ];

  if (isUs) {
    const stateInput = new TextInputBuilder()
      .setCustomId('reg_state_code')
      .setLabel('US State (2-letter code, e.g. NY, CA, TX)')
      .setPlaceholder('NY')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(2)
      .setMaxLength(2);
    rows.push(new ActionRowBuilder().addComponents(stateInput));
  }

  modal.addComponents(...rows);

  return interaction.showModal(modal);
}

/**
 * Send the wallet panel in a wallet channel.
 */
async function sendWalletPanel(channel, wallet, user = null) {
  const { buildWalletView } = require('../panels/walletPanelView');
  const lang = (user && user.language) || 'en';
  const view = buildWalletView(wallet, user, lang);
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

  const lang = user.language || 'en';
  const view = buildWalletView(wallet, user, lang);
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

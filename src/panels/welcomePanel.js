const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageRow } = require('../locales');

/**
 * Build the welcome/TOS panel for the static welcome channel.
 * The panel renders in the requested language. The actual TOS contents (regional
 * restrictions, prohibited countries) stay in English because they reference
 * specific legal jurisdictions which we don't translate to avoid ambiguity.
 */
function buildWelcomePanel(lang = 'en') {
  const welcomeEmbed = new EmbedBuilder()
    .setTitle(t('onboarding.welcome_title', lang))
    .setColor(0x3498db)
    .setDescription(t('onboarding.welcome_desc', lang));

  // The TOS itself stays in English — translating legal language is risky
  // and the regional restrictions reference specific places by name.
  const tos1Embed = new EmbedBuilder()
    .setTitle(t('onboarding.tos_title', lang))
    .setColor(0x3498db)
    .setDescription([
      '**1. ELIGIBILITY**',
      'You must be at least 18 years old to participate in wagers. By accepting, you confirm you meet this age requirement. We reserve the right to request age verification at any time.',
      '',
      '**2. REGIONAL RESTRICTIONS**',
      'Skill-based wagering is prohibited in certain jurisdictions. You confirm you are NOT located in:',
      '- **US States:** Arizona, Arkansas, Connecticut, Hawaii, Iowa, Louisiana, Mississippi, Montana, Nevada, South Carolina, South Dakota, Tennessee, Utah',
      '- **Countries:** China, Japan, South Korea, Saudi Arabia, UAE, Qatar, Kuwait, Bahrain, Oman, Iran, Iraq, Afghanistan, Pakistan, North Korea, Vietnam',
      '- **Indian States:** Andhra Pradesh, Telangana, Tamil Nadu, Kerala',
      '',
      '**3. ACCOUNT RESPONSIBILITY**',
      '- One account per person — no alts, smurfs, or shared accounts',
      '- You are responsible for all activity on your account',
      '- Your registered COD Mobile UID must be YOUR account',
      '- Playing on someone else\'s behalf is prohibited and results in permanent ban and forfeiture of funds',
      '',
      '**4. WALLET & FUNDS**',
      '- Your deposits are stored securely in a wallet managed by the platform',
      '- Withdrawals are processed to your specified Solana wallet address',
      '- Minimum withdrawal: $0.50 USDC',
      '- You are responsible for providing correct withdrawal addresses — we cannot reverse blockchain transactions',
      '- Funds locked during active matches cannot be withdrawn until the match is over',
      '',
      '**5. WAGERS & MATCHES**',
      '- All wagers are final once both parties accept',
      '- You must use your registered COD Mobile account for all matches',
      '- Match results are determined by in-game outcome',
      '- Both teams must report results honestly — false reporting results in bans',
    ].join('\n'));

  const tos2Embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setDescription([
      '**6. DISPUTES**',
      '- Either team may dispute a match result within the reporting window',
      '- Disputes require screenshot/video evidence showing the match result and player UIDs',
      '- Admin decisions on disputes are final',
      '- Providing falsified evidence results in permanent ban and forfeiture of funds',
      '',
      '**7. PROHIBITED CONDUCT**',
      '- Cheating, hacking, exploiting, or using unauthorized software',
      '- Win trading, match fixing, or collusion',
      '- Harassment, threats, or abuse toward other players or staff',
      '- Attempting to manipulate or exploit the platform',
      '- Creating multiple accounts to circumvent bans',
      '',
      '**8. DISCLAIMERS**',
      '- We are not responsible for losses due to your own gameplay',
      '- We do not guarantee server uptime or availability',
      '- Blockchain transactions are irreversible — verify all addresses',
      '- We reserve the right to suspend accounts, void matches, or withhold funds in cases of suspected fraud or rule violations',
      '',
      '**9. MODIFICATIONS**',
      '- We may update these terms at any time',
      '- Continued use of the platform constitutes acceptance of updated terms',
      '- Major changes will be announced in the server',
    ].join('\n'));

  const verifyEmbed = new EmbedBuilder()
    .setTitle(t('onboarding.verify_title', lang))
    .setColor(0x2ecc71)
    .setDescription(t('onboarding.verify_desc', lang));

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tos_accept')
      .setLabel(t('onboarding.btn_accept', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tos_decline')
      .setLabel(t('onboarding.btn_decline', lang))
      .setStyle(ButtonStyle.Danger),
  );

  return {
    embeds: [welcomeEmbed, tos1Embed, tos2Embed, verifyEmbed],
    components: [actionRow, buildLanguageRow('welcome')],
  };
}

/**
 * Post (or refresh) the welcome panel in the static welcome channel.
 */
async function postWelcomePanel(client) {
  const channelId = process.env.WELCOME_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] WELCOME_CHANNEL_ID not set — skipping welcome panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] Welcome channel ${channelId} not found`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);

    // Find existing welcome panel (if any)
    const existingPanel = botMessages.find(
      m => m.embeds.length > 0 && (m.embeds[0]?.title?.includes('Rank $') || m.embeds[0]?.title?.includes('Welcome')),
    );

    const panel = buildWelcomePanel();

    if (existingPanel) {
      for (const [, m] of botMessages) {
        if (m.id !== existingPanel.id) {
          try { await m.delete(); } catch { /* */ }
        }
      }
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing welcome panel');
    } else {
      for (const [, m] of botMessages) {
        try { await m.delete(); } catch { /* */ }
      }
      await channel.send(panel);
      console.log('[Panel] Posted new welcome panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post welcome panel:', err.message);
  }
}

module.exports = { buildWelcomePanel, postWelcomePanel };

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Build the welcome/TOS panel for the static welcome channel.
 */
function buildWelcomePanel() {
  const welcomeEmbed = new EmbedBuilder()
    .setTitle('Welcome to Rank $ - Call of Duty Mobile Wagers and XP Matches')
    .setColor(0x3498db)
    .setDescription(
      'Before you can access the server, you must read and agree to our Terms of Service and verify your eligibility.\n\n' +
      'This is a skill-based competition platform for COD Mobile. Players can wager on their own matches against other players. ' +
      'This is **NOT gambling** — outcomes are determined by player skill, not chance.'
    );

  const tos1Embed = new EmbedBuilder()
    .setTitle('Terms of Service')
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
    .setTitle('Verification Required')
    .setColor(0x2ecc71)
    .setDescription([
      'By clicking **Accept**, you confirm **ALL** of the following:',
      '',
      '> I am 18 years of age or older',
      '> I am NOT located in any restricted US state or country listed above',
      '> I have read and agree to the Terms of Service above',
      '> I understand this platform involves real money wagering on my own skill-based gameplay',
      '',
      '**FALSE VERIFICATION IS PROHIBITED**',
      'If you falsely verify your age or location, your account will be permanently banned and any funds may be forfeited.',
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tos_accept')
      .setLabel('I Accept & Verify')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tos_decline')
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [welcomeEmbed, tos1Embed, tos2Embed, verifyEmbed], components: [row] };
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
      // Delete any OTHER bot messages (duplicates from past restarts)
      for (const [, m] of botMessages) {
        if (m.id !== existingPanel.id) {
          try { await m.delete(); } catch { /* */ }
        }
      }
      // Edit the one existing panel in place
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing welcome panel');
    } else {
      // No panel exists — clean up any stale bot messages and post fresh
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

const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { privateTextOverwrites } = require('../utils/permissions');
const userRepo = require('../database/repositories/userRepo');

/**
 * Start the onboarding process for a new guild member.
 * Creates a private text channel and sends TOS + verification embeds.
 */
async function startOnboarding(member) {
  const guild = member.guild;

  // Check if already registered
  const existingUser = userRepo.findByDiscordId(member.user.id);
  if (existingUser && existingUser.accepted_tos === 1) {
    console.log(`[Onboarding] ${member.user.tag} already registered — skipping`);
    return;
  }

  // Check for existing onboarding channel
  const channelName = `welcome-${member.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const existingChannel = guild.channels.cache.find(
    ch => ch.name === channelName && ch.type === ChannelType.GuildText,
  );
  if (existingChannel) {
    console.log(`[Onboarding] Channel ${channelName} already exists — skipping`);
    return;
  }

  const overwrites = privateTextOverwrites(guild, [member.id]);
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    reason: `Onboarding for ${member.user.tag}`,
  });

  // Embed 1: Welcome
  const welcomeEmbed = new EmbedBuilder()
    .setTitle('Welcome to CODM Wagers')
    .setColor(0x3498db)
    .setDescription(
      'Before you can access the server, you must read and agree to our Terms of Service and verify your eligibility.\n\n' +
      'This is a skill-based competition platform for COD Mobile. Players can wager on their own matches against other players. ' +
      'This is **NOT gambling** — outcomes are determined by player skill, not chance.'
    );

  // Embed 2: Terms of Service (split into two due to Discord 4096 char limit)
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
      '- Playing on someone else\'s behalf or having someone play for you is prohibited and results in permanent ban and forfeiture of funds',
      '',
      '**4. WALLET & FUNDS**',
      '- Deposits are held in a custodial wallet managed by the platform',
      '- Withdrawals are processed to your specified Solana wallet address',
      '- Minimum withdrawal: $5 USDC',
      '- You are responsible for providing correct withdrawal addresses — we cannot reverse blockchain transactions',
      '- Funds held in escrow during active matches cannot be withdrawn until the match concludes',
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

  // Embed 3: Verification
  const verifyEmbed = new EmbedBuilder()
    .setTitle('Verification Required')
    .setColor(0x2ecc71)
    .setDescription([
      'By clicking **Accept**, you confirm **ALL** of the following:',
      '',
      '> I am 18 years of age or older',
      '> I am NOT located in any restricted US state (AZ, AR, CT, HI, IA, LA, MS, MT, NV, SC, SD, TN, UT)',
      '> I am NOT located in any restricted country (China, Japan, South Korea, Saudi Arabia, UAE, Qatar, Kuwait, Bahrain, Oman, Iran, Iraq, Afghanistan, Pakistan, North Korea, Vietnam)',
      '> I am NOT located in any restricted Indian state (Andhra Pradesh, Telangana, Tamil Nadu, Kerala)',
      '> I have read and agree to the Terms of Service above',
      '> I understand this platform involves real money wagering on my own skill-based gameplay',
      '',
      '**FALSE VERIFICATION IS PROHIBITED**',
      'If you falsely verify your age or location, your account will be permanently banned and any funds may be forfeited. We reserve the right to request identity verification at any time.',
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

  await channel.send({ content: `Welcome, <@${member.id}>! Please read the information below.` });
  await channel.send({ embeds: [welcomeEmbed] });
  await channel.send({ embeds: [tos1Embed, tos2Embed] });
  await channel.send({ embeds: [verifyEmbed], components: [row] });

  console.log(`[Onboarding] Created onboarding channel for ${member.user.tag}`);
}

module.exports = { startOnboarding };

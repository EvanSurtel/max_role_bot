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
    .setTitle('Welcome to Rank$ — Competitive COD Mobile')
    .setColor(0x3498db)
    .setDescription(
      'Before you can access the server, you must read and agree to our Terms of Service and verify your eligibility. ' +
      'Rank$ is a skill-based competition platform for COD Mobile. Players compete in cash matches against other players. ' +
      'Outcomes are determined entirely by player skill, not chance.'
    );

  // Embed 2: Terms of Service (split into two due to Discord 4096 char limit)
  const tos1Embed = new EmbedBuilder()
    .setTitle('Terms of Service')
    .setColor(0x3498db)
    .setDescription([
      '**1. ELIGIBILITY**',
      'You must be at least 18 years old to participate in cash matches. By accepting, you confirm you meet this age requirement. We reserve the right to request age verification at any time.',
      '',
      '**2. REGIONAL RESTRICTIONS**',
      'Skill-based cash competitions are not permitted in certain jurisdictions. You confirm you are NOT located in:',
      '\u2022 US States: Arkansas, Connecticut, Delaware, Louisiana, South Carolina, South Dakota',
      '\u2022 Countries: Iran, North Korea, Syria, Cuba, China, Afghanistan, Iraq, Pakistan, Russia, Myanmar, Sudan, Venezuela',
      '\u2022 Indian States: Andhra Pradesh, Assam, Karnataka, Meghalaya, Nagaland, Odisha, Sikkim, Telangana',
      '',
      '**3. ACCOUNT RESPONSIBILITY**',
      '\u2022 One account per person \u2014 no alternate accounts, shared accounts, or playing on behalf of others',
      '\u2022 You are responsible for all activity on your account',
      '\u2022 Your registered COD Mobile UID must be your own account',
      '\u2022 Playing on someone else\'s behalf is prohibited and results in permanent ban and forfeiture of funds',
      '',
      '**4. WALLET & FUNDS**',
      '\u2022 Your funds are stored securely in a platform-managed wallet on the Base network',
      '\u2022 Deposits are made via supported payment providers',
      '\u2022 Withdrawals are processed to your specified external wallet address on the Base network',
      '\u2022 Minimum withdrawal: $5 USDC',
      '\u2022 You are responsible for providing correct wallet addresses and selecting the correct network (Base) \u2014 blockchain transactions are irreversible and cannot be recovered',
      '\u2022 Funds locked during active matches cannot be withdrawn until the match concludes',
      '',
      '**5. CASH MATCHES**',
      '\u2022 All match entries are final once both parties accept',
      '\u2022 You must use your registered COD Mobile account for all matches',
      '\u2022 Match results are determined by in-game outcome',
      '\u2022 Both teams must report results honestly \u2014 false reporting results in bans and forfeiture of funds',
      '\u2022 Entry fees are collected from each participant before the match begins and held in escrow until the match concludes',
      '\u2022 The winning team receives the match prize upon confirmation of the result',
    ].join('\n'));

  const tos2Embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setDescription([
      '**6. DISPUTES**',
      '\u2022 Either team may dispute a match result within the reporting window',
      '\u2022 Disputes require screenshot or video evidence showing the match result and player UIDs',
      '\u2022 Admin decisions on disputes are final',
      '\u2022 After a dispute is resolved, the winning team\'s prize is subject to a 36-hour hold before becoming available for withdrawal',
      '\u2022 Providing false or fabricated evidence results in permanent ban and forfeiture of funds',
      '',
      '**7. PROHIBITED CONDUCT**',
      '\u2022 Cheating, hacking, exploiting, or using unauthorized software or hardware (including but not limited to Cronus, XIM, strikepacks, or similar input-manipulation devices)',
      '\u2022 Match fixing, win trading, or any form of collusion',
      '\u2022 Using matches as a money transfer service or to settle external arrangements',
      '\u2022 Harassment, threats, or abuse toward other players or staff',
      '\u2022 Attempting to manipulate or exploit the platform',
      '\u2022 Creating multiple accounts or circumventing bans',
      '',
      '**8. PENALTIES**',
      '\u2022 Violations may result in warnings, temporary bans, permanent bans, or forfeiture of funds at the discretion of platform administrators',
      '\u2022 Permanent bans result in loss of access to all funds on the platform',
      '\u2022 Penalty decisions are final',
      '',
      '**9. DISCLAIMERS**',
      '\u2022 This is a skill-based competition platform \u2014 outcomes depend entirely on player performance',
      '\u2022 We are not responsible for losses resulting from your gameplay performance',
      '\u2022 We do not guarantee server uptime or availability',
      '\u2022 Blockchain transactions on the Base network are irreversible \u2014 verify all addresses and network selection before confirming',
      '\u2022 We reserve the right to suspend accounts, void matches, or withhold funds in cases of suspected fraud, cheating, or rule violations',
      '\u2022 Platform fees may apply to match entries and withdrawals',
      '',
      '**10. MODIFICATIONS**',
      '\u2022 We may update these terms at any time',
      '\u2022 Continued use of the platform constitutes acceptance of updated terms',
      '\u2022 Significant changes will be announced in the server',
    ].join('\n'));

  // Embed 3: Verification
  const verifyEmbed = new EmbedBuilder()
    .setTitle('Verification Required')
    .setColor(0x2ecc71)
    .setDescription([
      'By clicking Accept, you confirm ALL of the following:',
      '\u2705 I am 18 years of age or older',
      '\u2705 I am NOT located in any restricted US state, country, or region listed above',
      '\u2705 I have read and agree to the Terms of Service',
      '\u2705 I understand this platform involves real money skill-based competition',
      '',
      '**FALSE VERIFICATION IS PROHIBITED**',
      'If you falsely verify your age or location, your account will be permanently banned and any funds will be forfeited.',
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

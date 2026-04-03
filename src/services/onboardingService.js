const { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { onboardingEmbed } = require('../utils/embeds');
const { privateTextOverwrites } = require('../utils/permissions');
const userRepo = require('../database/repositories/userRepo');

/**
 * Start the onboarding process for a new guild member.
 * Creates a private text channel and sends Terms & Conditions with Accept/Decline buttons.
 * @param {import('discord.js').GuildMember} member
 */
async function startOnboarding(member) {
  const guild = member.guild;

  // 1. Check if user already accepted TOS
  const existingUser = userRepo.findByDiscordId(member.user.id);
  if (existingUser && existingUser.accepted_tos === 1) {
    console.log(`[Onboarding] ${member.user.tag} already onboarded — skipping`);
    return;
  }

  // 2. Check if an onboarding channel already exists for this user
  const channelName = `welcome-${member.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const existingChannel = guild.channels.cache.find(
    ch => ch.name === channelName && ch.type === ChannelType.GuildText,
  );
  if (existingChannel) {
    console.log(`[Onboarding] Channel ${channelName} already exists for ${member.user.tag} — skipping`);
    return;
  }

  const overwrites = privateTextOverwrites(guild, [member.id]);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    reason: `Onboarding channel for ${member.user.tag}`,
  });

  // Build the TOS embed
  const embed = onboardingEmbed();

  // Build Accept/Decline buttons
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tos_accept')
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tos_decline')
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `Welcome, ${member}! Please read the Terms of Service below.`,
    embeds: [embed],
    components: [row],
  });

  console.log(`[Onboarding] Created onboarding channel for ${member.user.tag}`);
}

module.exports = { startOnboarding };

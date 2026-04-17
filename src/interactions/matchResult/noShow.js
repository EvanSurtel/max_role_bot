// No-show report + confirmation flow.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');
const { MATCH_STATUS, CHALLENGE_STATUS, PLAYER_ROLE } = require('../../config/constants');

/**
 * Handle the no-show report button and its confirmation.
 *
 * First click (noshow_report_{matchId}) shows a confirmation embed.
 * Second click (noshow_confirm_{matchId}) marks the match as disputed
 * and notifies staff in the admin alerts channel.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleNoShowReport(interaction) {
  const id = interaction.customId;

  // First click -- show confirmation
  if (id.startsWith('noshow_report_')) {
    const matchId = parseInt(id.replace('noshow_report_', ''), 10);
    const match = matchRepo.findById(matchId);
    if (!match || match.status !== MATCH_STATUS.ACTIVE) {
      return interaction.reply({ content: 'Match is no longer active.', ephemeral: true });
    }

    // Check 15 min has passed since match creation
    const matchCreatedAt = new Date(match.created_at).getTime();
    const elapsedMinutes = (Date.now() - matchCreatedAt) / 60000;
    const noShowMinutes = 15; // CMG standard
    if (elapsedMinutes < noShowMinutes) {
      const remaining = Math.ceil(noShowMinutes - elapsedMinutes);
      return interaction.reply({
        content: `You can only report a no-show after **${noShowMinutes} minutes** from match start. **${remaining} minute(s) remaining.**`,
        ephemeral: true,
      });
    }

    const user = userRepo.findByDiscordId(interaction.user.id);
    if (!user) return interaction.reply({ content: 'Not registered.', ephemeral: true });

    const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
    let reporterTeam = null;
    for (const p of allPlayers) {
      if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
        reporterTeam = p.team;
        break;
      }
    }
    if (!reporterTeam) {
      return interaction.reply({ content: 'Only captains can report no-shows.', ephemeral: true });
    }

    const otherTeam = reporterTeam === 1 ? 2 : 1;

    const confirmEmbed = new EmbedBuilder()
      .setTitle('Confirm No-Show')
      .setColor(0xe74c3c)
      .setDescription(`You are reporting that **Team ${otherTeam} did not show up** within 10 minutes of match start.\n\nThis will flag the match for staff review.\n\nAre you sure?`);

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`noshow_confirm_${matchId}`)
        .setLabel('Yes, They Didn\'t Show Up')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('report_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
  }

  // Confirmed no-show
  const matchId = parseInt(id.replace('noshow_confirm_', ''), 10);
  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.ACTIVE) {
    return interaction.reply({ content: 'Match is no longer active.', ephemeral: true });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'Not registered.', ephemeral: true });

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let reporterTeam = null;
  for (const p of allPlayers) {
    if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
      reporterTeam = p.team;
      break;
    }
  }
  if (!reporterTeam) {
    return interaction.reply({ content: 'Only captains can report no-shows.', ephemeral: true });
  }

  const otherTeam = reporterTeam === 1 ? 2 : 1;

  matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

  await interaction.reply({
    content: `**No-show reported.** Team ${reporterTeam} claims Team ${otherTeam} did not show up. Staff has been notified.`,
  });

  // Post admin resolve buttons to staff-only channel (admin alerts)
  const adsRoleId = process.env.ADS_ROLE_ID;
  const ceoRoleId = process.env.CEO_ROLE_ID;
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const wagerStaffId = process.env.WAGER_STAFF_ROLE_ID;
  const xpStaffId = process.env.XP_STAFF_ROLE_ID;
  const pings = [];
  if (wagerStaffId) pings.push(`<@&${wagerStaffId}>`);
  if (xpStaffId) pings.push(`<@&${xpStaffId}>`);
  if (adminRoleId) pings.push(`<@&${adminRoleId}>`);
  if (ownerRoleId) pings.push(`<@&${ownerRoleId}>`);
  if (ceoRoleId) pings.push(`<@&${ceoRoleId}>`);
  if (adsRoleId) pings.push(`<@&${adsRoleId}>`);

  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel('Team 1 Wins').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel('Team 2 Wins').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin_resolve_nowinner_${matchId}`).setLabel('No Winner').setStyle(ButtonStyle.Secondary),
  );

  const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
  if (alertChannelId) {
    const alertCh = interaction.client.channels.cache.get(alertChannelId);
    if (alertCh) {
      await alertCh.send({
        content: `**No-Show Report \u2014 Match #${matchId}**\nTeam ${reporterTeam} says Team ${otherTeam} didn't show up.\n\n${pings.join(' ')} \u2014 please verify and resolve.`,
        components: [adminRow],
      });
    }
  }
}

module.exports = { handleNoShowReport };

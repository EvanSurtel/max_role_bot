const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const matchService = require('../services/matchService');
const { MATCH_STATUS, CHALLENGE_STATUS, PLAYER_ROLE } = require('../config/constants');

/**
 * Check if a member has dispute resolution permissions (admin or wager staff).
 */
function canResolveDisputes(member) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const wagerStaffId = process.env.WAGER_STAFF_ROLE_ID;
  const xpStaffId = process.env.XP_STAFF_ROLE_ID;
  if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
  if (wagerStaffId && member.roles.cache.has(wagerStaffId)) return true;
  if (xpStaffId && member.roles.cache.has(xpStaffId)) return true;
  return false;
}

/**
 * Handle all match result button interactions.
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  // No-show report + confirmation
  if (id.startsWith('noshow_report_') || id.startsWith('noshow_confirm_')) return handleNoShowReport(interaction);

  // Both captains report: "We Won" or "We Lost" — show confirmation first
  if (id.startsWith('report_won_')) return showReportConfirm(interaction, 'won');
  if (id.startsWith('report_lost_')) return showReportConfirm(interaction, 'lost');

  // Confirmed report
  if (id.startsWith('confirm_won_')) return handleReport(interaction, 'won');
  if (id.startsWith('confirm_lost_')) return handleReport(interaction, 'lost');

  // Cancel report
  if (id === 'report_cancel') {
    try {
      return await interaction.update({ content: 'Report cancelled.', embeds: [], components: [] });
    } catch {
      return interaction.reply({ content: 'Report cancelled.', ephemeral: true });
    }
  }

  // Dispute
  if (id.startsWith('submit_evidence_')) return handleSubmitEvidenceButton(interaction);

  // Admin resolve
  if (id.startsWith('admin_resolve_team1_') || id.startsWith('admin_resolve_team2_')) return handleAdminResolve(interaction);
  if (id.startsWith('admin_confirm_')) return handleAdminConfirm(interaction);
  if (id.startsWith('admin_goback_')) return handleAdminGoBack(interaction);
}

/**
 * Handle modal submissions (evidence).
 */
async function handleModal(interaction) {
  if (interaction.customId.startsWith('evidence_modal_')) {
    return handleEvidenceSubmission(interaction);
  }
}

// ─── No-Show Report ──────────────────────────────────────────────

async function handleNoShowReport(interaction) {
  const id = interaction.customId;

  // First click — show confirmation
  if (id.startsWith('noshow_report_')) {
    const matchId = parseInt(id.replace('noshow_report_', ''), 10);
    const match = matchRepo.findById(matchId);
    if (!match || match.status !== MATCH_STATUS.ACTIVE) {
      return interaction.reply({ content: 'Match is no longer active.', ephemeral: true });
    }

    // Check 10 min has passed since match creation
    const matchCreatedAt = new Date(match.created_at).getTime();
    const elapsedMinutes = (Date.now() - matchCreatedAt) / 60000;
    if (elapsedMinutes < 10) {
      const remaining = Math.ceil(10 - elapsedMinutes);
      return interaction.reply({
        content: `You can only report a no-show after **10 minutes** from match start. **${remaining} minute(s) remaining.**`,
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

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

  // Post admin resolve buttons to staff-only channel (admin alerts), NOT the vote channel
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const wagerStaffId = process.env.WAGER_STAFF_ROLE_ID;
  const xpStaffId = process.env.XP_STAFF_ROLE_ID;
  const pings = [];
  if (wagerStaffId) pings.push(`<@&${wagerStaffId}>`);
  if (xpStaffId) pings.push(`<@&${xpStaffId}>`);
  if (adminRoleId) pings.push(`<@&${adminRoleId}>`);

  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel('Team 1 Wins').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel('Team 2 Wins').setStyle(ButtonStyle.Danger),
  );

  // Send to admin alerts channel (staff only)
  const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
  if (alertChannelId) {
    const alertCh = interaction.client.channels.cache.get(alertChannelId);
    if (alertCh) {
      await alertCh.send({
        content: `**No-Show Report — Match #${matchId}**\nTeam ${reporterTeam} says Team ${otherTeam} didn't show up.\n\n${pings.join(' ')} — please verify and resolve.`,
        components: [adminRow],
      });
    }
  }
}

// ─── Report Confirmation ─────────────────────────────────────────

async function showReportConfirm(interaction, outcome) {
  const matchId = parseInt(interaction.customId.replace(`report_${outcome}_`, ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: 'Invalid match.', ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

  if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: 'This match is no longer accepting reports.', ephemeral: true });
  }

  // Check minimum time before reporting
  const { MIN_REPORT_MINUTES } = require('../config/constants');
  const challenge = challengeRepo.findById(match.challenge_id);
  const minMinutes = MIN_REPORT_MINUTES[challenge?.series_length] || 5;
  const matchCreatedAt = new Date(match.created_at).getTime();
  const elapsedMinutes = (Date.now() - matchCreatedAt) / 60000;

  if (elapsedMinutes < minMinutes) {
    const remaining = Math.ceil(minMinutes - elapsedMinutes);
    return interaction.reply({
      content: `You can't report yet. Minimum **${minMinutes} minutes** must pass for a Best of ${challenge?.series_length || '?'} match. **${remaining} minute(s) remaining.**`,
      ephemeral: true,
    });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'Not registered.', ephemeral: true });

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let captainTeam = null;
  for (const p of allPlayers) {
    if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
      captainTeam = p.team;
      break;
    }
  }
  if (!captainTeam) {
    return interaction.reply({ content: 'Only team captains can report results.', ephemeral: true });
  }

  if (captainTeam === 1 && match.captain1_vote !== null) {
    return interaction.reply({ content: 'You already reported.', ephemeral: true });
  }
  if (captainTeam === 2 && match.captain2_vote !== null) {
    return interaction.reply({ content: 'You already reported.', ephemeral: true });
  }

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Confirm Report')
    .setColor(outcome === 'won' ? 0x2ecc71 : 0xe74c3c)
    .setDescription(
      outcome === 'won'
        ? `You are reporting that **your team (Team ${captainTeam}) WON** Match #${matchId}.\n\nAre you sure?`
        : `You are reporting that **your team (Team ${captainTeam}) LOST** Match #${matchId}.\n\nAre you sure?`
    );

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_${outcome}_${matchId}`)
      .setLabel(outcome === 'won' ? 'Yes, We Won' : 'Yes, We Lost')
      .setStyle(outcome === 'won' ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('report_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

// ─── Both Captains Report (CMG-style) ────────────────────────────

async function handleReport(interaction, outcome) {
  // customId: confirm_won_{matchId} or confirm_lost_{matchId}
  const matchId = parseInt(interaction.customId.replace(`confirm_${outcome}_`, ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: 'Invalid match.', ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

  if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: 'This match is no longer accepting reports.', ephemeral: true });
  }

  // Verify captain
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'Not registered.', ephemeral: true });

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let captainTeam = null;
  for (const p of allPlayers) {
    if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
      captainTeam = p.team;
      break;
    }
  }
  if (!captainTeam) {
    return interaction.reply({ content: 'Only team captains can report results.', ephemeral: true });
  }

  // Check if this captain already reported
  if (captainTeam === 1 && match.captain1_vote !== null) {
    return interaction.reply({ content: 'You already reported. Waiting for the other captain.', ephemeral: true });
  }
  if (captainTeam === 2 && match.captain2_vote !== null) {
    return interaction.reply({ content: 'You already reported. Waiting for the other captain.', ephemeral: true });
  }

  // Determine what team this captain says won
  let reportedWinner;
  if (outcome === 'won') {
    reportedWinner = captainTeam; // "we won" = my team won
  } else {
    reportedWinner = captainTeam === 1 ? 2 : 1; // "we lost" = other team won
  }

  // Record the vote
  matchRepo.setCaptainVote(matchId, captainTeam, reportedWinner);

  if (match.status === MATCH_STATUS.ACTIVE) {
    matchRepo.updateStatus(matchId, MATCH_STATUS.VOTING);
  }

  // Log to admin feed
  const { postTransaction } = require('../utils/transactionFeed');
  postTransaction({ type: 'match_report', username: user.server_username, discordId: user.discord_id, challengeId: match.challenge_id, memo: `Match #${matchId} | Team ${captainTeam} captain reported: ${outcome === 'won' ? 'WE WON' : 'WE LOST'} (says Team ${reportedWinner} won)` });

  // Update the ephemeral confirmation message
  try {
    await interaction.update({
      content: `You reported: **${outcome === 'won' ? 'We Won' : 'We Lost'}**. Waiting for the other captain to report.`,
      embeds: [],
      components: [],
    });
  } catch {
    await interaction.reply({
      content: `You reported: **${outcome === 'won' ? 'We Won' : 'We Lost'}**. Waiting for the other captain to report.`,
      ephemeral: true,
    });
  }

  // Re-fetch to check if both have now reported
  const updatedMatch = matchRepo.findById(matchId);
  const c1Vote = captainTeam === 1 ? reportedWinner : updatedMatch.captain1_vote;
  const c2Vote = captainTeam === 2 ? reportedWinner : updatedMatch.captain2_vote;

  if (c1Vote !== null && c2Vote !== null) {
    // Both reported
    if (c1Vote === c2Vote) {
      // AGREE — same team reported as winner by both
      const winningTeam = c1Vote;

      try {
        const voteChannel = interaction.client.channels.cache.get(match.voting_channel_id);
        if (voteChannel) {
          await voteChannel.send({
            content: `Both captains agree: **Team ${winningTeam} wins!** Resolving match...`,
          });
        }
        await matchService.resolveMatch(interaction.client, matchId, winningTeam);
      } catch (err) {
        console.error(`[MatchResult] Failed to resolve match #${matchId}:`, err);
      }
    } else {
      // DISAGREE — dispute
      await triggerDispute(interaction.client, matchId);

      const voteChannel = interaction.client.channels.cache.get(match.voting_channel_id);
      if (voteChannel) {
        await voteChannel.send({
          content: `**Captains disagree!** Team 1 says Team ${c1Vote} won, Team 2 says Team ${c2Vote} won. Match is now **disputed**.`,
        });
      }
    }
  }
}

// ─── Dispute ─────────────────────────────────────────────────────

/**
 * Trigger dispute — mark match as disputed, create dispute channels.
 */
async function triggerDispute(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match) return;

  if (match.status === MATCH_STATUS.DISPUTED) {
    console.log(`[MatchResult] Match #${matchId} already disputed, skipping`);
    return;
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) return;

  matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

  // Get all players' Discord IDs
  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  const allDiscordIds = [];
  for (const player of allPlayers) {
    const u = userRepo.findById(player.user_id);
    if (u) allDiscordIds.push(u.discord_id);
  }

  // Create dispute channels in the match category
  let disputeText = null;
  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
    if (guild && match.category_id) {
      const { ChannelType } = require('discord.js');
      const { sharedOverwrites } = require('../utils/permissions');

      disputeText = await guild.channels.create({
        name: 'dispute',
        type: ChannelType.GuildText,
        parent: match.category_id,
        permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
      });

      await guild.channels.create({
        name: 'Dispute Call',
        type: ChannelType.GuildVoice,
        parent: match.category_id,
        permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
      });
    }
  } catch (err) {
    console.error(`[MatchResult] Failed to create dispute channels:`, err.message);
  }

  const notifyChannel = disputeText || (match.shared_text_id ? client.channels.cache.get(match.shared_text_id) : null);

  if (notifyChannel) {
    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const staffRoleId = process.env.WAGER_STAFF_ROLE_ID;
    const pings = [];
    if (staffRoleId) pings.push(`<@&${staffRoleId}>`);
    if (adminRoleId) pings.push(`<@&${adminRoleId}>`);
    const staffPing = pings.length > 0 ? pings.join(' ') : 'Staff';
    const allPings = allDiscordIds.map(id => `<@${id}>`).join(' ');

    const evidenceRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`submit_evidence_${matchId}`).setLabel('Submit Evidence').setStyle(ButtonStyle.Primary),
    );

    await notifyChannel.send({
      content: `**Match Disputed!**\n\n${allPings}\n\nBoth teams — submit evidence using the button below or discuss in the voice call.\n\n${staffPing} — please review and resolve.`,
      components: [evidenceRow],
    });

    const adminRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel('Team 1 Wins').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel('Team 2 Wins').setStyle(ButtonStyle.Danger),
    );

    await notifyChannel.send({ content: '**Staff Panel** — After reviewing evidence, resolve:', components: [adminRow] });
  }

  const { postTransaction: ptx } = require('../utils/transactionFeed');
  ptx({ type: 'match_disputed', challengeId: match.challenge_id, memo: `Match #${matchId} disputed — channels created for staff review` });

  console.log(`[MatchResult] Match #${matchId} disputed`);
}

// ─── Evidence ────────────────────────────────────────────────────

async function handleSubmitEvidenceButton(interaction) {
  const matchId = parseInt(interaction.customId.replace('submit_evidence_', ''), 10);
  const modal = new ModalBuilder()
    .setCustomId(`evidence_modal_${matchId}`)
    .setTitle('Submit Dispute Evidence');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('evidence_link').setLabel('Link to evidence (screenshot/video)').setPlaceholder('https://...').setStyle(TextInputStyle.Short).setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('evidence_notes').setLabel('Additional notes (optional)').setPlaceholder('Explain what happened...').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
    ),
  );

  return interaction.showModal(modal);
}

async function handleEvidenceSubmission(interaction) {
  const matchId = parseInt(interaction.customId.replace('evidence_modal_', ''), 10);
  const link = interaction.fields.getTextInputValue('evidence_link').trim();
  const notes = interaction.fields.getTextInputValue('evidence_notes')?.trim() || '';

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

  try {
    const evidenceRepo = require('../database/repositories/evidenceRepo');
    evidenceRepo.create(matchId, interaction.user.id, link, notes);
  } catch (err) {
    console.error(`[MatchResult] Failed to store evidence:`, err.message);
  }

  await interaction.reply({ content: 'Your evidence has been submitted.', ephemeral: true });

  if (match.voting_channel_id) {
    const voteChannel = interaction.client.channels.cache.get(match.voting_channel_id);
    if (voteChannel) {
      const embed = new EmbedBuilder()
        .setTitle('Evidence Submitted')
        .setColor(0x3498db)
        .setDescription(`**From:** <@${interaction.user.id}>`)
        .addFields({ name: 'Link', value: link })
        .setTimestamp();
      if (notes) embed.addFields({ name: 'Notes', value: notes });
      await voteChannel.send({ embeds: [embed] });
    }
  }
}

// ─── Admin/Staff Resolve ─────────────────────────────────────────

async function handleAdminResolve(interaction) {
  const id = interaction.customId;

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: 'Only admins and wager staff can resolve disputes.', ephemeral: true });
  }

  let winningTeam, matchId;
  if (id.startsWith('admin_resolve_team1_')) {
    winningTeam = 1;
    matchId = parseInt(id.replace('admin_resolve_team1_', ''), 10);
  } else {
    winningTeam = 2;
    matchId = parseInt(id.replace('admin_resolve_team2_', ''), 10);
  }

  if (isNaN(matchId)) return interaction.reply({ content: 'Invalid match.', ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.DISPUTED) {
    return interaction.reply({ content: 'This match is not in a disputed state.', ephemeral: true });
  }

  // Show confirmation with team rosters
  const { formatUsdc } = require('../utils/embeds');
  const challenge = challengeRepo.findById(match.challenge_id);
  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);

  const losingTeam = winningTeam === 1 ? 2 : 1;
  const winnerNames = allPlayers.filter(p => p.team === winningTeam).map(p => {
    const u = userRepo.findById(p.user_id);
    return u ? `<@${u.discord_id}> ${u.cod_ign ? `(${u.cod_ign})` : ''}` : 'Unknown';
  });
  const loserNames = allPlayers.filter(p => p.team === losingTeam).map(p => {
    const u = userRepo.findById(p.user_id);
    return u ? `<@${u.discord_id}> ${u.cod_ign ? `(${u.cod_ign})` : ''}` : 'Unknown';
  });

  const potText = challenge && Number(challenge.total_pot_usdc) > 0
    ? `\n\n**Pot:** ${formatUsdc(challenge.total_pot_usdc)} USDC will be paid to the winners.`
    : '';

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Are you sure?')
    .setColor(0xe74c3c)
    .setDescription([
      `You are awarding the win to **Team ${winningTeam}**.`,
      '', `**Winners (Team ${winningTeam}):**`, ...winnerNames,
      '', `**Losers (Team ${losingTeam}):**`, ...loserNames,
      potText, '', '**This cannot be undone.**',
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_confirm_${matchId}_${winningTeam}`).setLabel(`Confirm Team ${winningTeam} Wins`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin_goback_${matchId}`).setLabel('Go Back').setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [confirmEmbed], components: [row] });
}

async function handleAdminConfirm(interaction) {
  const parts = interaction.customId.replace('admin_confirm_', '').split('_');
  const matchId = parseInt(parts[0], 10);
  const winningTeam = parseInt(parts[1], 10);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: 'Only admins and wager staff can resolve disputes.', ephemeral: true });
  }

  const { logAdminAction } = require('../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_dispute', 'match', matchId, { winningTeam });

  await interaction.update({
    content: `<@${interaction.user.id}> resolved the dispute. **Team ${winningTeam} wins!** Paying out...`,
    embeds: [], components: [],
  });

  try {
    await matchService.resolveMatch(interaction.client, matchId, winningTeam);
    const { cleanupDisputeChannels } = require('./disputeCreate');
    setTimeout(() => {
      cleanupDisputeChannels(interaction.client, matchId).catch(() => {});
    }, 30000);
  } catch (err) {
    console.error(`[MatchResult] Admin resolve failed for match #${matchId}:`, err);
  }
}

async function handleAdminGoBack(interaction) {
  const matchId = parseInt(interaction.customId.replace('admin_goback_', ''), 10);
  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel('Team 1 Wins').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel('Team 2 Wins').setStyle(ButtonStyle.Danger),
  );
  return interaction.update({ content: '**Staff Panel** — Review evidence, then resolve:', embeds: [], components: [adminRow] });
}

module.exports = { handleButton, handleModal, triggerDispute };

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
const { MATCH_STATUS, CHALLENGE_STATUS, TIMERS } = require('../config/constants');

// Track response deadline timers
const responseTimers = new Map(); // matchId -> timeout handle

/**
 * Handle all match result button interactions.
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  // Step 1: Captain clicks "Report Win"
  if (id.startsWith('report_win_')) {
    return handleReportWin(interaction);
  }

  // Step 2: Opponent clicks "Accept" (claim is valid)
  if (id.startsWith('result_accept_')) {
    return handleAcceptResult(interaction);
  }

  // Step 2: Opponent clicks "Dispute"
  if (id.startsWith('result_dispute_')) {
    return handleDisputeResult(interaction);
  }

  // Step 3: Confirmation — "Yes, they won"
  if (id.startsWith('result_confirm_')) {
    return handleConfirmResult(interaction);
  }

  // Step 3: "Go Back" — return to accept/dispute screen
  if (id.startsWith('result_goback_')) {
    return handleGoBack(interaction);
  }

  // Dispute evidence submission button
  if (id.startsWith('submit_evidence_')) {
    return handleSubmitEvidenceButton(interaction);
  }

  // Admin resolve buttons
  if (id.startsWith('admin_resolve_team1_') || id.startsWith('admin_resolve_team2_')) {
    return handleAdminResolve(interaction);
  }

  // Admin confirmation
  if (id.startsWith('admin_confirm_')) {
    return handleAdminConfirm(interaction);
  }

  // Admin go back
  if (id.startsWith('admin_goback_')) {
    return handleAdminGoBack(interaction);
  }
}

/**
 * Handle modal submissions (evidence, admin).
 */
async function handleModal(interaction) {
  if (interaction.customId.startsWith('evidence_modal_')) {
    return handleEvidenceSubmission(interaction);
  }
}

// ─── Step 1: Report Win ──────────────────────────────────────────

async function handleReportWin(interaction) {
  const matchId = parseInt(interaction.customId.replace('report_win_', ''), 10);
  if (isNaN(matchId)) {
    return interaction.reply({ content: 'Invalid match.', ephemeral: true });
  }

  const match = matchRepo.findById(matchId);
  if (!match) {
    return interaction.reply({ content: 'Match not found.', ephemeral: true });
  }

  if (match.status !== MATCH_STATUS.ACTIVE) {
    return interaction.reply({ content: 'This match is no longer active.', ephemeral: true });
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) {
    return interaction.reply({ content: 'Challenge not found.', ephemeral: true });
  }

  // Verify the user is a captain
  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({ content: 'You are not registered.', ephemeral: true });
  }

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let reporterTeam = null;
  for (const player of allPlayers) {
    if (player.user_id === user.id && player.role === 'captain') {
      reporterTeam = player.team;
      break;
    }
  }

  if (reporterTeam === null) {
    return interaction.reply({ content: 'Only team captains can report results.', ephemeral: true });
  }

  // Check if someone already reported
  if (match.captain1_vote !== null || match.captain2_vote !== null) {
    return interaction.reply({ content: 'A result has already been reported for this match.', ephemeral: true });
  }

  // Record the report: the reporter's team claims they won
  matchRepo.setCaptainVote(matchId, reporterTeam, reporterTeam);
  matchRepo.updateStatus(matchId, MATCH_STATUS.VOTING);

  await interaction.reply({
    content: `You reported that **Team ${reporterTeam}** won. The other captain has been notified.`,
    ephemeral: true,
  });

  // Find the other captain and send them the claim
  const otherTeam = reporterTeam === 1 ? 2 : 1;
  let otherCaptainDiscordId = null;
  for (const player of allPlayers) {
    if (player.team === otherTeam && player.role === 'captain') {
      const otherUser = userRepo.findById(player.user_id);
      if (otherUser) otherCaptainDiscordId = otherUser.discord_id;
      break;
    }
  }

  // Send the claim to the voting channel
  const voteChannel = interaction.client.channels.cache.get(match.voting_channel_id);
  if (voteChannel) {
    const claimEmbed = new EmbedBuilder()
      .setTitle(`Match #${matchId}`)
      .setColor(0xe67e22)
      .setDescription(
        `<@${discordId}> claims **Team ${reporterTeam}** won.\nDo you accept this result?`
      )
      .setFooter({ text: 'You have 10 minutes to respond.' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`result_accept_${matchId}_${reporterTeam}`)
        .setLabel('Accept')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`result_dispute_${matchId}`)
        .setLabel('Dispute')
        .setStyle(ButtonStyle.Danger),
    );

    const mention = otherCaptainDiscordId ? `<@${otherCaptainDiscordId}>` : 'Other captain';
    await voteChannel.send({
      content: `${mention} — the other captain has reported a result:`,
      embeds: [claimEmbed],
      components: [row],
    });
  }

  // Start 10-minute response timer — auto-dispute if no response
  if (!responseTimers.has(matchId)) {
    const timer = setTimeout(async () => {
      responseTimers.delete(matchId);
      try {
        const currentMatch = matchRepo.findById(matchId);
        if (!currentMatch || currentMatch.status !== MATCH_STATUS.VOTING) return;

        // Auto-dispute
        await triggerDispute(interaction.client, matchId);
      } catch (err) {
        console.error(`[MatchResult] Error handling response timeout for match #${matchId}:`, err);
      }
    }, 10 * 60 * 1000); // 10 minutes

    responseTimers.set(matchId, timer);
  }
}

// ─── Step 2: Accept ──────────────────────────────────────────────

async function handleAcceptResult(interaction) {
  // customId: result_accept_{matchId}_{winningTeam}
  const parts = interaction.customId.replace('result_accept_', '').split('_');
  const matchId = parseInt(parts[0], 10);
  const winningTeam = parseInt(parts[1], 10);

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: 'This match is no longer accepting responses.', ephemeral: true });
  }

  // Verify this is the OTHER captain (not the one who reported)
  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({ content: 'You are not registered.', ephemeral: true });
  }

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let responderTeam = null;
  for (const player of allPlayers) {
    if (player.user_id === user.id && player.role === 'captain') {
      responderTeam = player.team;
      break;
    }
  }

  if (responderTeam === null) {
    return interaction.reply({ content: 'Only team captains can respond.', ephemeral: true });
  }

  if (responderTeam === winningTeam) {
    return interaction.reply({ content: 'You reported this win — waiting for the other captain to respond.', ephemeral: true });
  }

  // Show confirmation screen
  const { formatUsdc } = require('../utils/embeds');
  const challenge = challengeRepo.findById(match.challenge_id);
  const potText = challenge && Number(challenge.total_pot_usdc) > 0
    ? `\n\nYour team will **lose** and forfeit the pot of **${formatUsdc(challenge.total_pot_usdc)} USDC**. This cannot be undone.`
    : '\n\nThis cannot be undone.';

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Are you sure?')
    .setColor(0xe74c3c)
    .setDescription(
      `You are confirming that **Team ${winningTeam}** won this match.${potText}`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`result_confirm_${matchId}_${winningTeam}`)
      .setLabel('Yes, they won')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`result_goback_${matchId}_${winningTeam}`)
      .setLabel('Go Back')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({
    content: '',
    embeds: [confirmEmbed],
    components: [row],
  });
}

// ─── Step 3: Confirm ─────────────────────────────────────────────

async function handleConfirmResult(interaction) {
  const parts = interaction.customId.replace('result_confirm_', '').split('_');
  const matchId = parseInt(parts[0], 10);
  const winningTeam = parseInt(parts[1], 10);

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: 'This match is no longer accepting responses.', ephemeral: true });
  }

  // Clear the response timer
  const existingTimer = responseTimers.get(matchId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    responseTimers.delete(matchId);
  }

  await interaction.update({
    content: `**Match #${matchId} confirmed.** Team ${winningTeam} wins! Paying out...`,
    embeds: [],
    components: [],
  });

  // Resolve the match
  try {
    await matchService.resolveMatch(interaction.client, matchId, winningTeam);

    // Notify in shared channel
    if (match.shared_text_id) {
      const sharedChannel = interaction.client.channels.cache.get(match.shared_text_id);
      if (sharedChannel) {
        await sharedChannel.send({
          content: `Both captains agree: **Team ${winningTeam} wins!** Match resolved and payouts sent.`,
        });
      }
    }
  } catch (err) {
    console.error(`[MatchResult] Failed to resolve match #${matchId}:`, err);
  }
}

// ─── Go Back ─────────────────────────────────────────────────────

async function handleGoBack(interaction) {
  const parts = interaction.customId.replace('result_goback_', '').split('_');
  const matchId = parseInt(parts[0], 10);
  const winningTeam = parseInt(parts[1], 10);

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: 'This match is no longer accepting responses.', ephemeral: true });
  }

  // Return to accept/dispute screen
  const claimEmbed = new EmbedBuilder()
    .setTitle(`Match #${matchId}`)
    .setColor(0xe67e22)
    .setDescription(`The other captain claims **Team ${winningTeam}** won.\nDo you accept this result?`)
    .setFooter({ text: 'You have 10 minutes to respond.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`result_accept_${matchId}_${winningTeam}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`result_dispute_${matchId}`)
      .setLabel('Dispute')
      .setStyle(ButtonStyle.Danger),
  );

  return interaction.update({
    embeds: [claimEmbed],
    components: [row],
  });
}

// ─── Dispute ─────────────────────────────────────────────────────

async function handleDisputeResult(interaction) {
  const matchId = parseInt(interaction.customId.replace('result_dispute_', ''), 10);

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: 'This match is no longer accepting responses.', ephemeral: true });
  }

  // Clear the response timer
  const existingTimer = responseTimers.get(matchId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    responseTimers.delete(matchId);
  }

  await interaction.update({
    content: `**Match #${matchId}** has been disputed. Both teams have been notified to submit evidence.`,
    embeds: [],
    components: [],
  });

  await triggerDispute(interaction.client, matchId);
}

/**
 * Trigger dispute — mark match as disputed, create dispute text + voice channels,
 * ping both teams and admins.
 */
async function triggerDispute(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match) return;

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) return;

  // Prevent duplicate dispute channel creation
  if (match.status === MATCH_STATUS.DISPUTED) {
    console.log(`[MatchResult] Match #${matchId} already disputed, skipping`);
    return;
  }

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
  let disputeVoice = null;

  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
    if (guild && match.category_id) {
      const { ChannelType } = require('discord.js');
      const { sharedOverwrites } = require('../utils/permissions');

      // Dispute text channel — both teams + admins can see
      disputeText = await guild.channels.create({
        name: 'dispute',
        type: ChannelType.GuildText,
        parent: match.category_id,
        permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
        reason: 'Wager bot dispute channel',
      });

      // Dispute voice channel — for live call between teams + admin
      disputeVoice = await guild.channels.create({
        name: 'Dispute Call',
        type: ChannelType.GuildVoice,
        parent: match.category_id,
        permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
        reason: 'Wager bot dispute voice channel',
      });

      console.log(`[MatchResult] Created dispute channels for match #${matchId}`);
    }
  } catch (err) {
    console.error(`[MatchResult] Failed to create dispute channels for match #${matchId}:`, err.message);
  }

  // Send dispute notification in the dispute text channel (or shared channel as fallback)
  const notifyChannel = disputeText || (match.shared_text_id ? client.channels.cache.get(match.shared_text_id) : null);

  if (notifyChannel) {
    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const adminPing = adminRoleId ? `<@&${adminRoleId}>` : 'Admins';
    const allPings = allDiscordIds.map(id => `<@${id}>`).join(' ');

    const evidenceRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`submit_evidence_${matchId}`)
        .setLabel('Submit Evidence')
        .setStyle(ButtonStyle.Primary),
    );

    await notifyChannel.send({
      content: [
        '**Match Disputed!**',
        '',
        `${allPings}`,
        '',
        'Both teams — submit evidence (screenshots, video links) using the button below or discuss in the voice call.',
        '',
        `${adminPing} — please join the dispute call and review evidence to resolve this.`,
      ].join('\n'),
      components: [evidenceRow],
    });

    // Admin resolve buttons
    const adminRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`admin_resolve_team1_${matchId}`)
        .setLabel('Team 1 Wins')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`admin_resolve_team2_${matchId}`)
        .setLabel('Team 2 Wins')
        .setStyle(ButtonStyle.Danger),
    );

    await notifyChannel.send({
      content: '**Admin Panel** — After reviewing evidence, resolve the dispute:',
      components: [adminRow],
    });
  }

  // Also notify in shared channel if dispute channel was created separately
  if (disputeText && match.shared_text_id) {
    const sharedChannel = client.channels.cache.get(match.shared_text_id);
    if (sharedChannel) {
      await sharedChannel.send({
        content: `**Match #${matchId} is now disputed.** Head to <#${disputeText.id}> to submit evidence and discuss.`,
      });
    }
  }

  console.log(`[MatchResult] Match #${matchId} disputed`);
}

// ─── Evidence Submission ─────────────────────────────────────────

async function handleSubmitEvidenceButton(interaction) {
  const matchId = parseInt(interaction.customId.replace('submit_evidence_', ''), 10);

  const modal = new ModalBuilder()
    .setCustomId(`evidence_modal_${matchId}`)
    .setTitle('Submit Dispute Evidence');

  const linkInput = new TextInputBuilder()
    .setCustomId('evidence_link')
    .setLabel('Link to evidence (screenshot/video)')
    .setPlaceholder('https://...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const notesInput = new TextInputBuilder()
    .setCustomId('evidence_notes')
    .setLabel('Additional notes (optional)')
    .setPlaceholder('Explain what happened...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(linkInput),
    new ActionRowBuilder().addComponents(notesInput),
  );

  return interaction.showModal(modal);
}

async function handleEvidenceSubmission(interaction) {
  const matchId = parseInt(interaction.customId.replace('evidence_modal_', ''), 10);
  const link = interaction.fields.getTextInputValue('evidence_link').trim();
  const notes = interaction.fields.getTextInputValue('evidence_notes')?.trim() || '';

  const match = matchRepo.findById(matchId);
  if (!match) {
    return interaction.reply({ content: 'Match not found.', ephemeral: true });
  }

  // Store evidence in DB first (persists after channels deleted)
  try {
    const evidenceRepo = require('../database/repositories/evidenceRepo');
    evidenceRepo.create(matchId, interaction.user.id, link, notes);
  } catch (err) {
    console.error(`[MatchResult] Failed to store evidence for match #${matchId}:`, err.message);
  }

  await interaction.reply({
    content: 'Your evidence has been submitted. An admin will review it.',
    ephemeral: true,
  });

  // Post the evidence in the voting channel for admin review
  if (match.voting_channel_id) {
    const voteChannel = interaction.client.channels.cache.get(match.voting_channel_id);
    if (voteChannel) {
      const evidenceEmbed = new EmbedBuilder()
        .setTitle('Evidence Submitted')
        .setColor(0x3498db)
        .setDescription(`**From:** <@${interaction.user.id}>`)
        .addFields(
          { name: 'Link', value: link },
        )
        .setTimestamp();

      if (notes) {
        evidenceEmbed.addFields({ name: 'Notes', value: notes });
      }

      await voteChannel.send({ embeds: [evidenceEmbed] });
    }
  }
}

// ─── Admin Resolve ───────────────────────────────────────────────

async function handleAdminResolve(interaction) {
  const id = interaction.customId;

  // Check admin role
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
    return interaction.reply({ content: 'Only admins can resolve disputes.', ephemeral: true });
  }

  let winningTeam, matchId;
  if (id.startsWith('admin_resolve_team1_')) {
    winningTeam = 1;
    matchId = parseInt(id.replace('admin_resolve_team1_', ''), 10);
  } else {
    winningTeam = 2;
    matchId = parseInt(id.replace('admin_resolve_team2_', ''), 10);
  }

  if (isNaN(matchId)) {
    return interaction.reply({ content: 'Invalid match.', ephemeral: true });
  }

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.DISPUTED) {
    return interaction.reply({ content: 'This match is not in a disputed state.', ephemeral: true });
  }

  // Show admin confirmation
  const { formatUsdc } = require('../utils/embeds');
  const challenge = challengeRepo.findById(match.challenge_id);
  const potText = challenge && Number(challenge.total_pot_usdc) > 0
    ? ` This pays out **${formatUsdc(challenge.total_pot_usdc)} USDC**.`
    : '';

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Admin Confirmation')
    .setColor(0xe74c3c)
    .setDescription(`Award win to **Team ${winningTeam}**?${potText}\n\nThis cannot be undone.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_confirm_${matchId}_${winningTeam}`)
      .setLabel(`Confirm Team ${winningTeam} Wins`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`admin_goback_${matchId}`)
      .setLabel('Go Back')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({
    embeds: [confirmEmbed],
    components: [row],
  });
}

async function handleAdminConfirm(interaction) {
  const parts = interaction.customId.replace('admin_confirm_', '').split('_');
  const matchId = parseInt(parts[0], 10);
  const winningTeam = parseInt(parts[1], 10);

  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
    return interaction.reply({ content: 'Only admins can resolve disputes.', ephemeral: true });
  }

  // Log admin action
  const { logAdminAction } = require('../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_dispute', 'match', matchId, { winningTeam });

  await interaction.update({
    content: `Admin <@${interaction.user.id}> resolved the dispute. **Team ${winningTeam} wins!** Paying out...`,
    embeds: [],
    components: [],
  });

  try {
    await matchService.resolveMatch(interaction.client, matchId, winningTeam);

    // Clean up dispute channels after a delay
    const { cleanupDisputeChannels } = require('./disputeCreate');
    setTimeout(() => {
      cleanupDisputeChannels(interaction.client, matchId).catch(err => {
        console.error(`[MatchResult] Failed to clean up dispute channels:`, err.message);
      });
    }, 30000); // 30 seconds to read the result
  } catch (err) {
    console.error(`[MatchResult] Admin resolve failed for match #${matchId}:`, err);
  }
}

async function handleAdminGoBack(interaction) {
  const matchId = parseInt(interaction.customId.replace('admin_goback_', ''), 10);

  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_resolve_team1_${matchId}`)
      .setLabel('Team 1 Wins')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`admin_resolve_team2_${matchId}`)
      .setLabel('Team 2 Wins')
      .setStyle(ButtonStyle.Danger),
  );

  return interaction.update({
    content: '**Admin Panel** — Review evidence submitted below, then resolve:',
    embeds: [],
    components: [adminRow],
  });
}

module.exports = { handleButton, handleModal };

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
  // Admin resolve
  if (id.startsWith('admin_resolve_team1_') || id.startsWith('admin_resolve_team2_') || id.startsWith('admin_resolve_nowinner_')) return handleAdminResolve(interaction);
  if (id.startsWith('admin_confirm_')) return handleAdminConfirm(interaction);
  if (id.startsWith('admin_confirm_nowinner_')) return handleAdminConfirmNoWinner(interaction);
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
    new ButtonBuilder().setCustomId(`admin_resolve_nowinner_${matchId}`).setLabel('No Winner').setStyle(ButtonStyle.Secondary),
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

    await notifyChannel.send({
      content: `**Match Disputed!**\n\n${allPings}\n\n**Post your evidence directly in this channel** — screenshots, photos, videos, links, text — anything to support your case.\n\nJoin the voice call to discuss.\n\n${staffPing} — please review evidence and resolve.`,
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

// Evidence is now submitted by posting directly in the dispute channel.
// No modal needed — users post text, images, links, whatever they want.
// When dispute resolves, all messages are archived to the permanent results channel.

// ─── Admin/Staff Resolve ─────────────────────────────────────────

async function handleAdminResolve(interaction) {
  const id = interaction.customId;

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: 'Only admins and wager staff can resolve disputes.', ephemeral: true });
  }

  let winningTeam, matchId;
  if (id.startsWith('admin_resolve_nowinner_')) {
    winningTeam = 0; // no winner
    matchId = parseInt(id.replace('admin_resolve_nowinner_', ''), 10);
  } else if (id.startsWith('admin_resolve_team1_')) {
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

  if (winningTeam === 0) {
    // No Winner confirmation
    const isWager = challenge && Number(challenge.total_pot_usdc) > 0;
    const refundText = isWager
      ? `\n\nAll players will be **refunded** their entry of ${formatUsdc(challenge.entry_amount_usdc)} USDC each.`
      : '\n\nNo XP changes will be applied.';

    const confirmEmbed = new EmbedBuilder()
      .setTitle('Confirm: No Winner')
      .setColor(0x95a5a6)
      .setDescription(`You are declaring **no winner** for Match #${matchId}.${refundText}\n\n**This cannot be undone.**`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_confirm_nowinner_${matchId}`).setLabel('Confirm No Winner').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`admin_goback_${matchId}`).setLabel('Go Back').setStyle(ButtonStyle.Primary),
    );

    return interaction.update({ embeds: [confirmEmbed], components: [row] });
  }

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

    // Post dispute result to permanent dispute results channel
    await postDisputeResult(interaction.client, matchId, winningTeam, interaction.user.id);

    const { cleanupDisputeChannels } = require('./disputeCreate');
    setTimeout(() => {
      cleanupDisputeChannels(interaction.client, matchId).catch(() => {});
    }, 30000);
  } catch (err) {
    console.error(`[MatchResult] Admin resolve failed for match #${matchId}:`, err);
  }
}

async function handleAdminConfirmNoWinner(interaction) {
  const matchId = parseInt(interaction.customId.replace('admin_confirm_nowinner_', ''), 10);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: 'Only admins and wager staff can resolve disputes.', ephemeral: true });
  }

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

  const challenge = challengeRepo.findById(match.challenge_id);

  const { logAdminAction } = require('../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_no_winner', 'match', matchId, {});

  await interaction.update({
    content: `<@${interaction.user.id}> declared **no winner** for Match #${matchId}. Refunding all players.`,
    embeds: [], components: [],
  });

  try {
    // For wagers: refund all escrow funds back to players
    if (challenge && challenge.type === 'wager' && Number(challenge.total_pot_usdc) > 0) {
      const escrowManager = require('../solana/escrowManager');
      const challengePlayerRepo2 = require('../database/repositories/challengePlayerRepo');
      const allPlayers = challengePlayerRepo2.findByChallengeId(match.challenge_id);
      const escrowKeypair = escrowManager.__test_getEscrowKeypair ? escrowManager.__test_getEscrowKeypair() : null;

      // Refund each player their entry amount from escrow
      for (const player of allPlayers) {
        try {
          const walletRepo = require('../database/repositories/walletRepo');
          const walletRecord = walletRepo.findByUserId(player.user_id);
          if (!walletRecord) continue;

          const transactionService = require('../solana/transactionService');
          const { Keypair } = require('@solana/web3.js');
          const secretKeyJson = process.env.ESCROW_WALLET_SECRET;
          if (!secretKeyJson) continue;
          const escrowKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson)));

          const { signature } = await transactionService.transferUsdc(
            escrowKp,
            walletRecord.solana_address,
            challenge.entry_amount_usdc,
          );

          // Update DB balance
          const currentAvailable = BigInt(walletRecord.balance_available);
          const entryAmount = BigInt(challenge.entry_amount_usdc);
          walletRepo.updateBalance(player.user_id, {
            balanceAvailable: (currentAvailable + entryAmount).toString(),
            balanceHeld: walletRecord.balance_held,
          });

          const transactionRepo = require('../database/repositories/transactionRepo');
          transactionRepo.create({
            type: 'refund',
            userId: player.user_id,
            challengeId: match.challenge_id,
            amountUsdc: challenge.entry_amount_usdc,
            solanaTxSignature: signature,
            fromAddress: escrowKp.publicKey.toBase58(),
            toAddress: walletRecord.solana_address,
            status: 'completed',
            memo: `Refund (no winner) for challenge #${match.challenge_id}`,
          });

          const { postTransaction } = require('../utils/transactionFeed');
          const userRecord = require('../database/repositories/userRepo').findById(player.user_id);
          postTransaction({ type: 'release', username: userRecord?.server_username, discordId: userRecord?.discord_id, amount: `$${(Number(challenge.entry_amount_usdc) / 1000000).toFixed(2)}`, currency: 'USDC', signature, challengeId: match.challenge_id, memo: `Refund (no winner)` });
        } catch (err) {
          console.error(`[MatchResult] Failed to refund player ${player.user_id}:`, err.message);
        }
      }
    }

    // Mark match as completed with no winner
    matchRepo.updateStatus(matchId, MATCH_STATUS.COMPLETED);
    challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.COMPLETED);

    // No XP changes for anyone

    // Post dispute result to permanent channel
    await postDisputeResult(interaction.client, matchId, 0, interaction.user.id);

    // Cleanup dispute channels
    const { cleanupDisputeChannels } = require('./disputeCreate');
    setTimeout(() => {
      cleanupDisputeChannels(interaction.client, matchId).catch(() => {});
    }, 30000);

    // Cleanup match channels
    setTimeout(() => {
      matchService.cleanupChannels(interaction.client, matchId).catch(() => {});
    }, 60000);

  } catch (err) {
    console.error(`[MatchResult] No-winner resolution failed for match #${matchId}:`, err);
  }
}

/**
 * Post full dispute result with all evidence to the permanent dispute results channel.
 */
async function postDisputeResult(client, matchId, winningTeam, resolverDiscordId) {
  const channelId = process.env.DISPUTE_RESULTS_CHANNEL_ID;
  if (!channelId) return;

  const ch = client.channels.cache.get(channelId);
  if (!ch) return;

  try {
    const match = matchRepo.findById(matchId);
    const challenge = match ? challengeRepo.findById(match.challenge_id) : null;
    const allPlayers = match ? challengePlayerRepo.findByChallengeId(match.challenge_id) : [];

    // Get all evidence from DB
    const evidenceRepo = require('../database/repositories/evidenceRepo');
    const allEvidence = evidenceRepo.findByMatchId(matchId);

    // Build team rosters
    const team1 = allPlayers.filter(p => p.team === 1).map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? `<@${u.discord_id}> ${u.cod_ign || ''}` : 'Unknown';
    });
    const team2 = allPlayers.filter(p => p.team === 2).map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? `<@${u.discord_id}> ${u.cod_ign || ''}` : 'Unknown';
    });

    const { GAME_MODES } = require('../config/constants');
    const { formatUsdc } = require('../utils/embeds');
    const modeInfo = challenge ? GAME_MODES[challenge.game_modes] : null;
    const modeLabel = modeInfo ? modeInfo.label : (challenge?.game_modes || 'N/A');

    const outcomeText = winningTeam === 0
      ? '**No Winner** — All funds refunded'
      : `**Team ${winningTeam} wins**`;

    const potText = challenge && Number(challenge.total_pot_usdc) > 0
      ? `**Pot:** ${formatUsdc(challenge.total_pot_usdc)} USDC`
      : 'XP Match';

    const resultEmbed = new EmbedBuilder()
      .setTitle(`Dispute Result — Match #${matchId}`)
      .setColor(winningTeam === 0 ? 0x95a5a6 : 0x2ecc71)
      .setDescription([
        `**Resolved by:** <@${resolverDiscordId}>`,
        `**Outcome:** ${outcomeText}`,
        '',
        `**Match Details**`,
        `Mode: ${modeLabel} | Bo${challenge?.series_length || '?'} | ${challenge?.team_size || '?'}v${challenge?.team_size || '?'}`,
        potText,
        '',
        `**Team 1:**`,
        ...team1,
        '',
        `**Team 2:**`,
        ...team2,
      ].join('\n'))
      .setTimestamp();

    await ch.send({ embeds: [resultEmbed] });

    // Archive all messages from the dispute channel (text + images)
    let disputeMessages = [];
    try {
      // Find the dispute channel (dispute-chat in the dispute category)
      const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
      if (guild && match.dispute_category_id) {
        const disputeChat = guild.channels.cache.find(
          c => c.parentId === match.dispute_category_id && c.name === 'dispute-chat'
        );
        if (disputeChat) {
          const msgs = await disputeChat.messages.fetch({ limit: 100 });
          disputeMessages = [...msgs.values()].reverse(); // oldest first
        }
      }
    } catch (err) {
      console.error(`[MatchResult] Failed to fetch dispute messages:`, err.message);
    }

    if (disputeMessages.length > 0) {
      await ch.send({ content: `**Evidence & Discussion (${disputeMessages.filter(m => !m.author.bot).length} messages):**` });

      for (const msg of disputeMessages) {
        if (msg.author.bot) continue; // skip bot messages

        const parts = [];
        parts.push(`**<@${msg.author.id}>** — ${msg.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`);
        if (msg.content) parts.push(msg.content);

        // Re-upload any image attachments
        const files = [];
        for (const [, att] of msg.attachments) {
          files.push(att.url);
        }

        const sendOpts = { content: parts.join('\n') };
        if (files.length > 0) {
          sendOpts.content += '\n' + files.join('\n');
        }

        try {
          await ch.send(sendOpts);
        } catch { /* skip if message too long */ }
      }
    } else {
      await ch.send({ content: `*No evidence was posted for Match #${matchId}.*` });
    }

    await ch.send({ content: '───────────────────────────────' });

  } catch (err) {
    console.error(`[MatchResult] Failed to post dispute result for match #${matchId}:`, err.message);
  }
}

async function handleAdminGoBack(interaction) {
  const matchId = parseInt(interaction.customId.replace('admin_goback_', ''), 10);
  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel('Team 1 Wins').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel('Team 2 Wins').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin_resolve_nowinner_${matchId}`).setLabel('No Winner').setStyle(ButtonStyle.Secondary),
  );
  return interaction.update({ content: '**Staff Panel** — Review evidence, then resolve:', embeds: [], components: [adminRow] });
}

module.exports = { handleButton, handleModal, triggerDispute };

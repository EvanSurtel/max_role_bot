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
const { t, langFor } = require('../locales/i18n');

/**
 * Check if a member has dispute resolution permissions (ads, CEO,
 * owner, admin, or match/XP staff). Ads, CEO, and owner have the
 * same powers as admin everywhere in the bot.
 */
function canResolveDisputes(member) {
  const adsRoleId = process.env.ADS_ROLE_ID;
  const ceoRoleId = process.env.CEO_ROLE_ID;
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const wagerStaffId = process.env.WAGER_STAFF_ROLE_ID;
  const xpStaffId = process.env.XP_STAFF_ROLE_ID;
  if (adsRoleId && member.roles.cache.has(adsRoleId)) return true;
  if (ceoRoleId && member.roles.cache.has(ceoRoleId)) return true;
  if (ownerRoleId && member.roles.cache.has(ownerRoleId)) return true;
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
    const lang = langFor(interaction);
    try {
      return await interaction.update({ content: t('match_result.report_cancelled', lang), embeds: [], components: [] });
    } catch {
      return interaction.reply({ content: t('match_result.report_cancelled', lang), ephemeral: true });
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
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace(`report_${outcome}_`, ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });

  if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: t('match_result.no_longer_reports', lang), ephemeral: true });
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
      content: t('match_result.cant_report_yet', lang, { minutes: minMinutes, series: challenge?.series_length || '?', remaining }),
      ephemeral: true,
    });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: t('common.not_registered_simple', lang), ephemeral: true });

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let captainTeam = null;
  for (const p of allPlayers) {
    if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
      captainTeam = p.team;
      break;
    }
  }
  if (!captainTeam) {
    return interaction.reply({ content: t('common.only_captains', lang), ephemeral: true });
  }

  if (captainTeam === 1 && match.captain1_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported', lang), ephemeral: true });
  }
  if (captainTeam === 2 && match.captain2_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported', lang), ephemeral: true });
  }

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('match_result.confirm_report_title', lang))
    .setColor(outcome === 'won' ? 0x2ecc71 : 0xe74c3c)
    .setDescription(
      outcome === 'won'
        ? t('match_result.confirm_won', lang, { team: captainTeam, matchId })
        : t('match_result.confirm_lost', lang, { team: captainTeam, matchId })
    );

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_${outcome}_${matchId}`)
      .setLabel(outcome === 'won' ? t('match_result.btn_yes_we_won', lang) : t('match_result.btn_yes_we_lost', lang))
      .setStyle(outcome === 'won' ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('report_cancel')
      .setLabel(t('common.cancel', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

// ─── Both Captains Report (CMG-style) ────────────────────────────

async function handleReport(interaction, outcome) {
  const lang = langFor(interaction);
  // customId: confirm_won_{matchId} or confirm_lost_{matchId}
  const matchId = parseInt(interaction.customId.replace(`confirm_${outcome}_`, ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });

  if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: t('match_result.no_longer_reports', lang), ephemeral: true });
  }

  // Verify captain
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: t('common.not_registered_simple', lang), ephemeral: true });

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let captainTeam = null;
  for (const p of allPlayers) {
    if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
      captainTeam = p.team;
      break;
    }
  }
  if (!captainTeam) {
    return interaction.reply({ content: t('common.only_captains', lang), ephemeral: true });
  }

  // Check if this captain already reported
  if (captainTeam === 1 && match.captain1_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported_waiting', lang), ephemeral: true });
  }
  if (captainTeam === 2 && match.captain2_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported_waiting', lang), ephemeral: true });
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

  // Update the ephemeral confirmation message in user's language
  const reportedKey = outcome === 'won' ? 'match_result.report_recorded_won' : 'match_result.report_recorded_lost';
  try {
    await interaction.update({
      content: t(reportedKey, lang),
      embeds: [],
      components: [],
    });
  } catch {
    await interaction.reply({
      content: t(reportedKey, lang),
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
          // Use first captain's language for shared vote channel announcement
          const allPlayersForLang = challengePlayerRepo.findByChallengeId(match.challenge_id);
          const captainPlayer = allPlayersForLang.find(p => p.role === PLAYER_ROLE.CAPTAIN);
          const captainUser = captainPlayer ? userRepo.findById(captainPlayer.user_id) : null;
          const sharedLang = captainUser ? langFor({ user: { id: captainUser.discord_id }, locale: '' }) : 'en';
          await voteChannel.send({
            content: t('match_channel.captains_agree', sharedLang, { team: winningTeam }),
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
        const allPlayersForLang = challengePlayerRepo.findByChallengeId(match.challenge_id);
        const captainPlayer = allPlayersForLang.find(p => p.role === PLAYER_ROLE.CAPTAIN);
        const captainUser = captainPlayer ? userRepo.findById(captainPlayer.user_id) : null;
        const sharedLang = captainUser ? langFor({ user: { id: captainUser.discord_id }, locale: '' }) : 'en';
        await voteChannel.send({
          content: t('match_channel.captains_disagree', sharedLang, { t1: c1Vote, t2: c2Vote }),
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

  // Hard block: a completed match cannot be re-disputed. Winnings
  // have already been disbursed; letting this proceed would allow a
  // losing player to chain their way into admin "no winner" refunds
  // from an escrow that's already been paid out.
  if (match.status === MATCH_STATUS.COMPLETED) {
    console.warn(`[MatchResult] triggerDispute refused — match #${matchId} is already completed`);
    return;
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) return;

  matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

  // Post dispute in the existing shared-chat channel (no new channels created)
  const sharedChannel = match.shared_text_id ? client.channels.cache.get(match.shared_text_id) : null;

  if (sharedChannel) {
    const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
    const allPings = allPlayers.map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? `<@${u.discord_id}>` : '';
    }).filter(Boolean).join(' ');

    // Use first captain's language for shared dispute message
    const captainPlayer = allPlayers.find(p => p.role === PLAYER_ROLE.CAPTAIN);
    const captainUser = captainPlayer ? userRepo.findById(captainPlayer.user_id) : null;
    const sharedLang = captainUser ? langFor({ user: { id: captainUser.discord_id }, locale: '' }) : 'en';

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
    const staffPing = pings.length > 0 ? pings.join(' ') : 'Staff';

    await sharedChannel.send({
      content: [
        t('match_channel.match_disputed_title', sharedLang),
        '',
        allPings,
        '',
        t('match_channel.match_disputed_post_evidence', sharedLang),
        '',
        t('match_channel.staff_review', sharedLang, { staff: staffPing }),
      ].join('\n'),
    });

    const adminRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel(t('admin_resolve.btn_team1_wins', sharedLang)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel(t('admin_resolve.btn_team2_wins', sharedLang)).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`admin_resolve_nowinner_${matchId}`).setLabel(t('admin_resolve.btn_no_winner', sharedLang)).setStyle(ButtonStyle.Secondary),
    );

    await sharedChannel.send({ content: t('admin_resolve.staff_panel_title', sharedLang), components: [adminRow] });
  }

  const { postTransaction: ptx } = require('../utils/transactionFeed');
  ptx({ type: 'match_disputed', challengeId: match.challenge_id, memo: `Match #${matchId} disputed` });

  console.log(`[MatchResult] Match #${matchId} disputed`);
}

// ─── Evidence ────────────────────────────────────────────────────

// Evidence is now submitted by posting directly in the dispute channel.
// No modal needed — users post text, images, links, whatever they want.
// When dispute resolves, all messages are archived to the permanent results channel.

// ─── Admin/Staff Resolve ─────────────────────────────────────────

async function handleAdminResolve(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: t('admin_resolve.only_admins', lang), ephemeral: true });
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

  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.DISPUTED) {
    return interaction.reply({ content: t('admin_resolve.not_disputed', lang), ephemeral: true });
  }

  // Show confirmation with team rosters
  const challenge = challengeRepo.findById(match.challenge_id);
  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);

  if (winningTeam === 0) {
    // No Winner confirmation
    const isCashMatch = challenge && Number(challenge.total_pot_usdc) > 0;
    const entryAmount = isCashMatch ? (Number(challenge.entry_amount_usdc) / 1_000_000).toFixed(2) : '0';
    const refundText = isCashMatch
      ? t('admin_resolve.refund_text_cash_match', lang, { amount: entryAmount })
      : t('admin_resolve.refund_text_xp', lang);

    const confirmEmbed = new EmbedBuilder()
      .setTitle(t('admin_resolve.confirm_no_winner_title', lang))
      .setColor(0x95a5a6)
      .setDescription(t('admin_resolve.confirm_no_winner_desc', lang, { matchId, refund_text: refundText }));

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_confirm_nowinner_${matchId}`).setLabel(t('admin_resolve.btn_confirm_no_winner', lang)).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`admin_goback_${matchId}`).setLabel(t('common.go_back', lang)).setStyle(ButtonStyle.Primary),
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

  const prizeAmount = challenge && Number(challenge.total_pot_usdc) > 0
    ? (Number(challenge.total_pot_usdc) / 1_000_000).toFixed(2)
    : null;
  const prizeText = prizeAmount
    ? '\n\n' + t('admin_resolve.match_prize_will_be_paid', lang, { amount: prizeAmount })
    : '';

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('admin_resolve.confirm_team_title', lang))
    .setColor(0xe74c3c)
    .setDescription([
      t('admin_resolve.confirm_team_desc', lang, { team: winningTeam }),
      '', t('admin_resolve.winners_team', lang, { team: winningTeam }), ...winnerNames,
      '', t('admin_resolve.losers_team', lang, { team: losingTeam }), ...loserNames,
      prizeText, '', t('admin_resolve.cannot_be_undone', lang),
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_confirm_${matchId}_${winningTeam}`).setLabel(t('admin_resolve.btn_confirm_team_wins', lang, { team: winningTeam })).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin_goback_${matchId}`).setLabel(t('common.go_back', lang)).setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [confirmEmbed], components: [row] });
}

async function handleAdminConfirm(interaction) {
  const lang = langFor(interaction);
  const parts = interaction.customId.replace('admin_confirm_', '').split('_');
  const matchId = parseInt(parts[0], 10);
  const winningTeam = parseInt(parts[1], 10);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: t('admin_resolve.only_admins', lang), ephemeral: true });
  }

  const { logAdminAction } = require('../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_dispute', 'match', matchId, { winningTeam });

  await interaction.update({
    content: t('admin_resolve.resolved_msg', lang, { user: `<@${interaction.user.id}>`, team: winningTeam }),
    embeds: [], components: [],
  });

  try {
    await matchService.resolveMatch(interaction.client, matchId, winningTeam);

    // Post dispute result to permanent dispute results channel
    await postDisputeResult(interaction.client, matchId, winningTeam, interaction.user.id);

    // Clean up match channels after resolution
    setTimeout(() => {
      matchService.cleanupChannels(interaction.client, matchId).catch(() => {});
    }, 30000);
  } catch (err) {
    console.error(`[MatchResult] Admin resolve failed for match #${matchId}:`, err);
  }
}

async function handleAdminConfirmNoWinner(interaction) {
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace('admin_confirm_nowinner_', ''), 10);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: t('admin_resolve.only_admins', lang), ephemeral: true });
  }

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });

  // Atomic idempotency claim. Before this guard, two admins clicking
  // "No Winner" within the same async window both entered the refund
  // loop and transferUsdc fired for every player TWICE — draining
  // escrow by 2× the pot amount.
  //
  // Claim the match from DISPUTED → COMPLETED atomically. Exactly
  // ONE caller wins the row. If the claim fails, the match is
  // already resolved (or never disputed) and we exit.
  const claimed = matchRepo.atomicStatusTransition(matchId, MATCH_STATUS.DISPUTED, MATCH_STATUS.COMPLETED);
  if (!claimed) {
    return interaction.update({
      content: 'This match has already been resolved.',
      embeds: [], components: [],
    });
  }

  const challenge = challengeRepo.findById(match.challenge_id);

  const { logAdminAction } = require('../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_no_winner', 'match', matchId, {});

  await interaction.update({
    content: t('admin_resolve.no_winner_resolved_msg', lang, { user: `<@${interaction.user.id}>`, matchId }),
    embeds: [], components: [],
  });

  try {
    // For cash matches: refund all escrow funds back to players
    if (challenge && challenge.type === 'cash_match' && Number(challenge.total_pot_usdc) > 0) {
      const challengePlayerRepo2 = require('../database/repositories/challengePlayerRepo');
      const allPlayers = challengePlayerRepo2.findByChallengeId(match.challenge_id);

      // Cancel the match on-chain via the smart contract.
      // The contract refunds all players' USDC from escrow back to
      // their individual wallets in a single transaction.
      const escrowManager = require('../base/escrowManager');
      try {
        await escrowManager.cancelOnChainMatch(
          matchId,
          match.challenge_id,
          allPlayers,
          challenge.entry_amount_usdc,
        );
      } catch (err) {
        console.error(`[MatchResult] On-chain cancel failed for match #${matchId}:`, err.message);
        const { postTransaction } = require('../utils/transactionFeed');
        postTransaction({
          type: 'balance_mismatch',
          challengeId: match.challenge_id,
          memo: `🚨 On-chain cancel FAILED for match #${matchId} (no winner). Error: ${err.message}`,
        });
      }
    }

    // Match already transitioned to COMPLETED by the atomic claim above.
    challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.COMPLETED);

    // No XP changes for anyone

    // Post dispute result to permanent dispute-results channel
    await postDisputeResult(interaction.client, matchId, 0, interaction.user.id);

    // Also post to the regular results channels — a no-winner dispute
    // resolution is still the official result of a match, so it belongs
    // in the same feed everyone watches for normal results.
    try {
      const { GAME_MODES } = require('../config/constants');
      const { formatUsdc } = require('../utils/embeds');
      const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
      const isCashMatch = challenge && challenge.type === 'cash_match' && Number(challenge.total_pot_usdc) > 0;
      const matchTypeLabel = isCashMatch ? 'Cash Match' : 'XP Match';
      const modeInfo = challenge ? GAME_MODES[challenge.game_modes] : null;
      const modeLabel = modeInfo ? modeInfo.label : (challenge?.game_modes || 'N/A');

      const team1Lines = allPlayers.filter(p => p.team === 1).map(p => {
        const u = userRepo.findById(p.user_id);
        if (!u) return null;
        const ign = u.cod_ign ? `(${u.cod_ign})` : '';
        return `<@${u.discord_id}> ${ign}`;
      }).filter(Boolean);
      const team2Lines = allPlayers.filter(p => p.team === 2).map(p => {
        const u = userRepo.findById(p.user_id);
        if (!u) return null;
        const ign = u.cod_ign ? `(${u.cod_ign})` : '';
        return `<@${u.discord_id}> ${ign}`;
      }).filter(Boolean);

      const refundText = isCashMatch
        ? `**No Winner — ${formatUsdc(challenge.total_pot_usdc)} USDC refunded to all players**`
        : '**No Winner — match cancelled**';

      const noWinnerEmbed = new EmbedBuilder()
        .setTitle(`${matchTypeLabel} #${matchId} — Result`)
        .setColor(0x95a5a6)
        .setDescription([
          refundText,
          '',
          `Resolved by <@${interaction.user.id}>`,
          '',
          '**Team 1**',
          ...team1Lines,
          '',
          '**Team 2**',
          ...team2Lines,
        ].join('\n'))
        .addFields(
          { name: 'Mode', value: modeLabel, inline: true },
          { name: 'Series', value: `Best of ${challenge?.series_length || '?'}`, inline: true },
          { name: 'Team Size', value: `${challenge?.team_size || '?'}v${challenge?.team_size || '?'}`, inline: true },
        )
        .setTimestamp();

      await matchService.postResultToChannels(interaction.client, noWinnerEmbed, [], isCashMatch, matchId);
    } catch (err) {
      console.error(`[MatchResult] Failed to post no-winner result to results channels for match #${matchId}:`, err.message);
    }

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

  // Try cache first, fall back to fetch — same cache-miss problem the
  // transactions channel had: low-traffic admin channels drop out of
  // the channel cache after a restart.
  let ch = client.channels.cache.get(channelId);
  if (!ch) {
    try { ch = await client.channels.fetch(channelId); } catch { ch = null; }
  }
  if (!ch) {
    console.error(`[MatchResult] DISPUTE_RESULTS_CHANNEL_ID=${channelId} unreachable for match #${matchId}`);
    return;
  }

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

    const prizeText = challenge && Number(challenge.total_pot_usdc) > 0
      ? `**Match Prize:** ${formatUsdc(challenge.total_pot_usdc)} USDC`
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
        prizeText,
        '',
        `**Team 1:**`,
        ...team1,
        '',
        `**Team 2:**`,
        ...team2,
      ].join('\n'))
      .setTimestamp();

    await ch.send({ embeds: [resultEmbed] });

    // Archive evidence messages from the shared-chat channel
    let disputeMessages = [];
    try {
      if (match.shared_text_id) {
        const sharedCh = client.channels.cache.get(match.shared_text_id);
        if (sharedCh) {
          const msgs = await sharedCh.messages.fetch({ limit: 100 });
          disputeMessages = [...msgs.values()].reverse();
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
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace('admin_goback_', ''), 10);
  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel(t('admin_resolve.btn_team1_wins', lang)).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel(t('admin_resolve.btn_team2_wins', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin_resolve_nowinner_${matchId}`).setLabel(t('admin_resolve.btn_no_winner', lang)).setStyle(ButtonStyle.Secondary),
  );
  return interaction.update({ content: t('admin_resolve.staff_panel_review', lang), embeds: [], components: [adminRow] });
}

module.exports = { handleButton, handleModal, triggerDispute };

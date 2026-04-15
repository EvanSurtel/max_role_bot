const { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../base/escrowManager');
const { privateTextOverwrites, privateVoiceOverwrites, votingChannelOverwrites, sharedOverwrites } = require('../utils/permissions');
const { formatUsdc } = require('../utils/embeds');
const { MATCH_STATUS, CHALLENGE_STATUS, CHALLENGE_TYPE, PLAYER_ROLE } = require('../config/constants');
const { calculateXpMatchRewards, calculateWagerXpRewards } = require('../utils/xpCalculator');
const { getCurrentSeason } = require('../panels/leaderboardPanel');
const neatqueueService = require('./neatqueueService');
const { t, getLang } = require('../locales/i18n');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

// For shared match channels, pick the language of the first captain found.
// Falls back to English if no captain or no preference saved.
function _captainLang(captainDiscordIds) {
  if (!captainDiscordIds || captainDiscordIds.length === 0) return 'en';
  return getLang(captainDiscordIds[0]);
}

/**
 * Post a result embed to the regular results channels (all-results +
 * cash-match-results). Used by both the normal resolve flow AND the admin
 * dispute-resolution flow (including no-winner) so dispute outcomes
 * still appear in the regular results feed.
 *
 * Tries the channel cache first and falls back to channels.fetch(),
 * because results channels are low-traffic admin channels that drop
 * out of cache after restarts.
 */
async function postResultToChannels(client, resultEmbed, components, isCashMatch, matchId) {
  async function _resolve(channelId) {
    let ch = client.channels.cache.get(channelId);
    if (!ch) {
      try { ch = await client.channels.fetch(channelId); } catch { ch = null; }
    }
    return ch;
  }

  const allResultsChannelId = process.env.RESULTS_CHANNEL_ID;
  if (allResultsChannelId) {
    try {
      const ch = await _resolve(allResultsChannelId);
      if (ch) await ch.send({ embeds: [resultEmbed], components: components || [] });
      else console.error(`[MatchService] all-results channel ${allResultsChannelId} unreachable for match #${matchId}`);
    } catch (err) {
      console.error(`[MatchService] Failed to post to all-results for match #${matchId}:`, err.message);
    }
  }

  if (isCashMatch) {
    const wagerResultsChannelId = process.env.WAGER_RESULTS_CHANNEL_ID;
    if (wagerResultsChannelId) {
      try {
        const ch = await _resolve(wagerResultsChannelId);
        if (ch) await ch.send({ embeds: [resultEmbed], components: components || [] });
        else console.error(`[MatchService] cash-match-results channel ${wagerResultsChannelId} unreachable for match #${matchId}`);
      } catch (err) {
        console.error(`[MatchService] Failed to post to cash-match-results for match #${matchId}:`, err.message);
      }
    }
  }
}

/**
 * Create match channels (team voice, team text, shared, voting) for a matched challenge.
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 * @returns {Promise<object>} The created match record.
 */
async function createMatchChannels(client, challenge) {
  // Get the guild — try from the challenge board channel first, then fallback to first guild
  let guild;
  if (challenge.challenge_channel_id) {
    const boardChannel = client.channels.cache.get(challenge.challenge_channel_id);
    if (boardChannel) {
      guild = boardChannel.guild;
    }
  }
  if (!guild) {
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      guild = client.guilds.cache.get(guildId);
    }
    if (!guild) {
      guild = client.guilds.cache.first();
    }
  }

  if (!guild) {
    throw new Error('Could not resolve guild for match channel creation');
  }

  // Get all players for this challenge
  const allPlayers = challengePlayerRepo.findByChallengeId(challenge.id);
  const team1Players = allPlayers.filter(p => p.team === 1);
  const team2Players = allPlayers.filter(p => p.team === 2);

  // Map player user IDs to Discord IDs
  const team1DiscordIds = [];
  const team2DiscordIds = [];
  const allDiscordIds = [];
  const captainDiscordIds = [];

  for (const player of team1Players) {
    const user = userRepo.findById(player.user_id);
    if (user) {
      team1DiscordIds.push(user.discord_id);
      allDiscordIds.push(user.discord_id);
      if (player.role === PLAYER_ROLE.CAPTAIN) {
        captainDiscordIds.push(user.discord_id);
      }
    }
  }

  for (const player of team2Players) {
    const user = userRepo.findById(player.user_id);
    if (user) {
      team2DiscordIds.push(user.discord_id);
      allDiscordIds.push(user.discord_id);
      if (player.role === PLAYER_ROLE.CAPTAIN) {
        captainDiscordIds.push(user.discord_id);
      }
    }
  }

  // Create a Discord category for this match
  const category = await guild.channels.create({
    name: `Match #${challenge.id}`,
    type: ChannelType.GuildCategory,
    reason: 'Match category',
  });

  // Create team 1 text channel
  const team1Text = await guild.channels.create({
    name: 'team-1',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: privateTextOverwrites(guild, team1DiscordIds, true),
    reason: 'Match channel',
  });

  // Create team 1 voice channel
  const team1Voice = await guild.channels.create({
    name: 'Team 1',
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: privateVoiceOverwrites(guild, team1DiscordIds, true),
    reason: 'Match channel',
  });

  // Create team 2 text channel
  const team2Text = await guild.channels.create({
    name: 'team-2',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: privateTextOverwrites(guild, team2DiscordIds, true),
    reason: 'Match channel',
  });

  // Create team 2 voice channel
  const team2Voice = await guild.channels.create({
    name: 'Team 2',
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: privateVoiceOverwrites(guild, team2DiscordIds, true),
    reason: 'Match channel',
  });

  // Create shared text channel
  const sharedText = await guild.channels.create({
    name: 'shared-chat',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
    reason: 'Match channel',
  });

  // Create shared voice channel
  const sharedVoice = await guild.channels.create({
    name: 'Shared Voice',
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
    reason: 'Match channel',
  });

  // Create voting channel (captains can view, only bot can send)
  const voteChannel = await guild.channels.create({
    name: 'vote',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: votingChannelOverwrites(guild, captainDiscordIds),
    reason: 'Match voting channel',
  });

  // Create match record in DB
  const match = matchRepo.create({
    challengeId: challenge.id,
    categoryId: category.id,
  });

  // Store all channel IDs
  matchRepo.setChannels(match.id, {
    team1VoiceId: team1Voice.id,
    team1TextId: team1Text.id,
    team2VoiceId: team2Voice.id,
    team2TextId: team2Text.id,
    sharedVoiceId: sharedVoice.id,
    sharedTextId: sharedText.id,
    votingChannelId: voteChannel.id,
  });

  // Calculate estimated match duration and post vote panel
  const { EmbedBuilder } = require('discord.js');
  const { estimateMatchDuration, formatDuration } = require('../utils/matchTimer');
  const estimatedMinutes = estimateMatchDuration(challenge.game_modes, challenge.series_length);

  // Use the first captain's language for shared match content (captain language).
  // Per-team welcome messages use that team's captain language separately below.
  const sharedLang = _captainLang(captainDiscordIds);
  const team1CaptainLang = getLang(team1DiscordIds.find(id => captainDiscordIds.includes(id)));
  const team2CaptainLang = getLang(team2DiscordIds.find(id => captainDiscordIds.includes(id)));

  const reportEmbed = new EmbedBuilder()
    .setTitle(t('match_channel.report_title', sharedLang, { matchId: match.id }))
    .setColor(0xe67e22)
    .setDescription([
      t('match_channel.estimated_time', sharedLang, { duration: formatDuration(estimatedMinutes) }),
      '',
      t('match_channel.report_intro', sharedLang),
      '',
      t('match_channel.report_how', sharedLang),
      '',
      t('match_channel.agree_resolved', sharedLang),
      t('match_channel.disagree_dispute', sharedLang),
      '',
      t('match_channel.no_show_hint', sharedLang),
    ].join('\n'))
    .setFooter({ text: t('match_channel.only_captains_footer', sharedLang) });

  const reportRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`report_won_${match.id}`)
      .setLabel(t('match_channel.btn_we_won', sharedLang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`report_lost_${match.id}`)
      .setLabel(t('match_channel.btn_we_lost', sharedLang))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`noshow_report_${match.id}`)
      .setLabel(t('match_channel.btn_no_show', sharedLang))
      .setStyle(ButtonStyle.Secondary),
  );

  const voteLangRow = buildLanguageDropdownRow(sharedLang);
  await voteChannel.send({
    embeds: [reportEmbed],
    components: [reportRow, voteLangRow],
  });

  // Build match info for welcome messages
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const prizeAmountFormatted = isCashMatch ? (Number(challenge.total_pot_usdc) / 1_000_000).toFixed(2) : '0';

  const typeLabel1 = isCashMatch ? t('challenge_create.type_cash_match', team1CaptainLang) : t('challenge_create.type_xp_match', team1CaptainLang);
  const typeLabel2 = isCashMatch ? t('challenge_create.type_cash_match', team2CaptainLang) : t('challenge_create.type_xp_match', team2CaptainLang);
  const typeLabelShared = isCashMatch ? t('challenge_create.type_cash_match', sharedLang) : t('challenge_create.type_xp_match', sharedLang);
  const prizeText1 = isCashMatch ? t('match_channel.match_prize_label', team1CaptainLang, { amount: prizeAmountFormatted }) : '';
  const prizeText2 = isCashMatch ? t('match_channel.match_prize_label', team2CaptainLang, { amount: prizeAmountFormatted }) : '';
  const prizeTextShared = isCashMatch ? t('match_channel.match_prize_label', sharedLang, { amount: prizeAmountFormatted }) : '';

  // Send welcome messages in team channels (each in their own captain's language)
  const team1LangRow = buildLanguageDropdownRow(team1CaptainLang);
  await team1Text.send({
    content: t('match_channel.team_welcome', team1CaptainLang, {
      team: 1,
      type: typeLabel1,
      num: challenge.display_number || challenge.id,
      pot_text: prizeText1,
    }),
    components: [team1LangRow],
  });

  const team2LangRow = buildLanguageDropdownRow(team2CaptainLang);
  await team2Text.send({
    content: t('match_channel.team_welcome', team2CaptainLang, {
      team: 2,
      type: typeLabel2,
      num: challenge.display_number || challenge.id,
      pot_text: prizeText2,
    }),
    components: [team2LangRow],
  });

  // Generate random map picks for the series
  const { pickMaps, formatMapPicks } = require('../utils/mapPicker');
  const mapPicks = pickMaps(challenge.game_modes, challenge.series_length);
  const mapText = mapPicks.length > 0 ? `\n\n${t('match_channel.shared_maps_header', sharedLang)}\n${formatMapPicks(mapPicks)}` : '';

  // Build team rosters with captain labels (translated)
  const captainLabel = t('challenge_accept.captain_label', sharedLang);
  const team1Lines = team1DiscordIds.map(id => {
    const isCaptain = captainDiscordIds.includes(id);
    return `<@${id}>${isCaptain ? ' ' + captainLabel : ''}`;
  });
  const team2Lines = team2DiscordIds.map(id => {
    const isCaptain = captainDiscordIds.includes(id);
    return `<@${id}>${isCaptain ? ' ' + captainLabel : ''}`;
  });

  // Shared chat welcome — uses first captain's language
  const sharedLangRow = buildLanguageDropdownRow(sharedLang);
  await sharedText.send({
    content: [
      t('match_channel.shared_match_header', sharedLang, {
        matchId: match.id,
        type: typeLabelShared,
        num: challenge.display_number || challenge.id,
      }),
      '',
      t('match_channel.shared_team1', sharedLang, { players: team1Lines.join(', ') }),
      t('match_channel.shared_team2', sharedLang, { players: team2Lines.join(', ') }),
      prizeTextShared,
      mapText,
      '',
      t('match_channel.shared_good_luck', sharedLang),
    ].join('\n'),
    components: [sharedLangRow],
  });

  // Update challenge status to in_progress
  challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.IN_PROGRESS);

  console.log(`[MatchService] Created match #${match.id} channels for challenge #${challenge.id}`);
  return match;
}

/**
 * Start a match — transfer held funds to escrow and create match channels.
 * Called when all opponent teammates have accepted (team games) or immediately (1v1).
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} challengeId - The challenge ID.
 * @returns {Promise<object>} The match record.
 */
async function startMatch(client, challengeId) {
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    throw new Error(`Challenge ${challengeId} not found`);
  }

  // Verify all players have accepted before starting
  const allPlayers = challengePlayerRepo.findByChallengeId(challengeId);
  const pendingPlayers = allPlayers.filter(p => p.status !== 'accepted');
  if (pendingPlayers.length > 0) {
    throw new Error(`Cannot start match: ${pendingPlayers.length} player(s) have not accepted`);
  }

  // Create match channels FIRST (so we have the match ID for the contract)
  const match = await createMatchChannels(client, challenge);

  // Transfer all held funds to escrow via smart contract (cash match challenges only)
  if (challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.entry_amount_usdc) > 0) {
    try {
      // Call the smart contract: create match on-chain + pull USDC from each player.
      // Gas is sponsored by the Coinbase Paymaster — no ETH needed.
      await escrowManager.transferToEscrow(
        match.id,                         // use match ID (not challenge ID) as the on-chain match ID
        challengeId,
        allPlayers.filter(p => p.funds_held),
        challenge.entry_amount_usdc,
        allPlayers.length,
      );
    } catch (err) {
      console.error(`[MatchService] ESCROW FAILURE for match #${match.id}:`, err.message);

      // Revert: refund all DB-held funds back to available
      try {
        escrowManager.refundAll(challengeId);
      } catch (refundErr) {
        console.error(`[MatchService] Refund after escrow failure also failed:`, refundErr.message);
      }

      // Revert: set challenge back to OPEN so it can be re-accepted
      challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.CANCELLED);

      // Clean up the match channels we just created
      try {
        await cleanupChannels(client, match.id);
      } catch { /* best effort */ }

      // Alert admins
      const { postTransaction } = require('../utils/transactionFeed');
      postTransaction({
        type: 'balance_mismatch',
        challengeId,
        memo: `🚨 Escrow transfer FAILED for match #${match.id}. Challenge cancelled + funds refunded. Error: ${err.message}`,
      });

      throw new Error(`Escrow transfer failed — match #${match.id} cancelled`);
    }
  }

  // Update challenge status to in_progress (createMatchChannels already does this, but be explicit)
  challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.IN_PROGRESS);

  // Update match status to active
  matchRepo.updateStatus(match.id, MATCH_STATUS.ACTIVE);

  // Start inactivity timer based on estimated match duration + buffer
  const timerService = require('./timerService');
  const { getAutoDisputeMs } = require('../utils/matchTimer');
  const autoDisputeMs = getAutoDisputeMs(challenge.game_modes, challenge.series_length);
  timerService.createTimer('match_inactivity', match.id, autoDisputeMs);
  console.log(`[MatchService] Auto-dispute timer set for match #${match.id}: ${Math.round(autoDisputeMs / 60000)} minutes`);

  const { postTransaction } = require('../utils/transactionFeed');
  postTransaction({ type: 'match_started', challengeId, memo: `Match #${match.id} started | ${challenge.team_size}v${challenge.team_size} | ${challenge.game_modes} | Bo${challenge.series_length}${challenge.type === 'cash_match' ? ` | Match Prize: $${(Number(challenge.total_pot_usdc) / 1000000).toFixed(2)}` : ' | XP Match'}` });

  // Start no-show reminder pings at 5min and 10min
  const playerDiscordIds = allPlayers.map(p => {
    const u = userRepo.findById(p.user_id);
    return u?.discord_id;
  }).filter(Boolean);
  startNoShowReminders(client, match, playerDiscordIds);

  console.log(`[MatchService] Match #${match.id} started for challenge #${challengeId}`);
  return match;
}

/**
 * Resolve a match after captain voting.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} matchId - The match ID.
 * @param {number} winningTeam - The winning team number (1 or 2).
 */
async function resolveMatch(client, matchId, winningTeam, { fromDispute = false } = {}) {
  const match = matchRepo.findById(matchId);
  if (!match) {
    throw new Error(`Match ${matchId} not found`);
  }

  // Atomic idempotency claim — prevents double-resolve races.
  //
  // The previous version read match.status and then did a bunch of
  // async work (disbursement) before finally setting the status to
  // COMPLETED. Two concurrent callers (e.g., both captains reporting
  // the same outcome within ~100ms, or an admin confirm colliding
  // with the inactivity auto-dispute timer) could both pass the
  // "status !== COMPLETED" check and both call disburseWinnings →
  // winners get paid 2x the match prize.
  //
  // Now we use matchRepo.atomicStatusTransition to flip the status
  // from the current live state (active / voting / disputed) to
  // COMPLETED inside a BEGIN IMMEDIATE transaction. Exactly ONE
  // caller wins the row, the rest see a false return and exit. The
  // status is already COMPLETED before disburseWinnings runs, which
  // matches the shape of the rest of the function (it just keeps
  // running and finishes the work).
  const LIVE_STATUSES = [MATCH_STATUS.ACTIVE, MATCH_STATUS.VOTING, MATCH_STATUS.DISPUTED];
  if (!LIVE_STATUSES.includes(match.status)) {
    console.warn(`[MatchService] resolveMatch called on match #${matchId} with status=${match.status} — skipping`);
    return;
  }
  const claimed = matchRepo.atomicStatusTransition(matchId, LIVE_STATUSES, MATCH_STATUS.COMPLETED);
  if (!claimed) {
    console.warn(`[MatchService] resolveMatch race lost on match #${matchId} — another caller already claimed it`);
    return;
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) {
    throw new Error(`Challenge ${match.challenge_id} not found for match ${matchId}`);
  }

  // Get winning team players
  const winningPlayers = challengePlayerRepo.findByChallengeAndTeam(match.challenge_id, winningTeam);
  const winnerUserIds = winningPlayers.map(p => p.user_id);

  // Disburse winnings (cash match challenges only).
  //
  // disburseWinnings returns `{ disbursements: [...] }` where each
  // entry is either `{userId, signature, amount}` (success) or
  // `{userId, error}` (failure). Previously the caller ignored
  // that detail completely — any failure was silently swallowed
  // and the match was marked COMPLETED with some winners unpaid
  // and no retry path.
  //
  // Now: if ANY disbursement failed, or any expected winner was
  // dropped before the loop (missing wallet), we revert the match
  // status back to DISPUTED and alert the admin channel. The
  // stranded escrow funds become an admin-visible problem that
  // can be resolved manually instead of a silent loss.
  if (challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0) {
    let disburseFailed = false;
    let disburseError = null;
    let disburseResult = null;
    try {
      disburseResult = await escrowManager.disburseWinnings(
        matchId,                    // on-chain match ID
        match.challenge_id,         // DB challenge ID for transaction records
        winnerUserIds,
        challenge.total_pot_usdc,
        { fromDispute },
      );
      const failedPayouts = (disburseResult.disbursements || []).filter(d => d.error);
      const successPayouts = (disburseResult.disbursements || []).filter(d => d.signature);
      if (failedPayouts.length > 0 || successPayouts.length < winnerUserIds.length) {
        disburseFailed = true;
        disburseError = failedPayouts.length > 0
          ? failedPayouts.map(d => `user ${d.userId}: ${d.error}`).join('; ')
          : `only ${successPayouts.length}/${winnerUserIds.length} winners paid`;
      } else {
        console.log(`[MatchService] Winnings disbursed for match #${matchId}, team ${winningTeam} won`);
      }
    } catch (err) {
      disburseFailed = true;
      disburseError = err.message;
      console.error(`[MatchService] Failed to disburse winnings for match #${matchId}:`, err.message);
    }

    if (disburseFailed) {
      // Revert the match status so the next admin action can take
      // over. Raise a loud alert so the operator knows real funds
      // are stranded in escrow.
      matchRepo.atomicStatusTransition(matchId, MATCH_STATUS.COMPLETED, MATCH_STATUS.DISPUTED);
      const { postTransaction } = require('../utils/transactionFeed');
      postTransaction({
        type: 'balance_mismatch',
        challengeId: match.challenge_id,
        memo: `🚨 Disbursement FAILED for match #${matchId} — status reverted to DISPUTED. Escrow may have stranded funds. Error: ${disburseError}`,
      });
      console.error(`[MatchService] CRITICAL: disbursement failed for match #${matchId}, status reverted. Admin action required.`);
      return;
    }

    // When resolved from a dispute, start a 36-hour hold timer for each
    // winner. The timer handler will move funds from pending_balance to
    // balance_available when it fires.
    if (fromDispute) {
      const timerService = require('./timerService');
      const { TIMERS } = require('../config/constants');
      for (const winnerId of winnerUserIds) {
        timerService.createTimer('dispute_hold_release', winnerId, TIMERS.DISPUTE_HOLD);
      }
      console.log(`[MatchService] 36-hour dispute hold timers created for ${winnerUserIds.length} winner(s) of match #${matchId}`);
    }
  }

  // Update match: set winner. Status was already flipped to COMPLETED
  // at the top of the function by the atomic idempotency claim, so
  // there's no second updateStatus call here.
  matchRepo.setWinner(matchId, winningTeam);

  // Update challenge status to completed
  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.COMPLETED);

  // Award XP and track stats
  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  const losingTeam = winningTeam === 1 ? 2 : 1;
  const losingPlayers = allPlayers.filter(p => p.team === losingTeam);
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0;

  // Calculate XP rewards based on match type
  let winXp, loseXp;
  if (isCashMatch) {
    const rewards = calculateWagerXpRewards(challenge.entry_amount_usdc);
    winXp = rewards.winXp;
    loseXp = rewards.loseXp;
  } else {
    // XP match — ELO-based calculation using team average XP
    const winnerXpTotal = winningPlayers.reduce((sum, p) => {
      const u = userRepo.findById(p.user_id);
      return sum + (u ? u.xp_points : 0);
    }, 0);
    const loserXpTotal = losingPlayers.reduce((sum, p) => {
      const u = userRepo.findById(p.user_id);
      return sum + (u ? u.xp_points : 0);
    }, 0);
    const winnerAvg = winningPlayers.length > 0 ? winnerXpTotal / winningPlayers.length : 0;
    const loserAvg = losingPlayers.length > 0 ? loserXpTotal / losingPlayers.length : 0;
    const rewards = calculateXpMatchRewards(winnerAvg, loserAvg);
    winXp = rewards.winXp;
    loseXp = rewards.loseXp;
  }

  // Store XP amounts on the match for the results embed
  match._winXp = winXp;
  match._loseXp = loseXp;

  // Compute per-player net earnings for cash matches
  let perPlayerEarnings = '0';
  if (isCashMatch) {
    const matchPrize = BigInt(challenge.total_pot_usdc);
    const winnerCount = BigInt(winningPlayers.length);
    const entryAmount = BigInt(challenge.entry_amount_usdc);
    const share = matchPrize / winnerCount;
    perPlayerEarnings = (share - entryAmount).toString();
  }

  // Log XP to xp_history table
  const db = require('../database/db');
  const insertXpHistory = db.prepare(
    'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
  );

  // Winners
  for (const player of winningPlayers) {
    try {
      userRepo.addXp(player.user_id, winXp);
      userRepo.addWin(player.user_id);
      insertXpHistory.run(player.user_id, matchId, challenge.type, winXp, getCurrentSeason());
      if (isCashMatch) {
        userRepo.addEarnings(player.user_id, perPlayerEarnings);
        userRepo.addEntered(player.user_id, challenge.entry_amount_usdc);
      }
    } catch (err) {
      console.error(`[MatchService] Failed to update stats for winner ${player.user_id}:`, err.message);
    }

    // Sync to NeatQueue: points + win
    if (neatqueueService.isConfigured()) {
      const winUser = userRepo.findById(player.user_id);
      if (winUser) {
        neatqueueService.addPoints(winUser.discord_id, winXp).catch(err => {
          console.error(`[MatchService] NeatQueue points failed for winner ${winUser.discord_id}:`, err.message);
        });
        neatqueueService.addWin(winUser.discord_id).catch(err => {
          console.error(`[MatchService] NeatQueue win failed for ${winUser.discord_id}:`, err.message);
        });
      }
    }
  }

  // Losers
  for (const player of losingPlayers) {
    try {
      if (loseXp > 0) {
        userRepo.addXp(player.user_id, -loseXp);
        insertXpHistory.run(player.user_id, matchId, challenge.type, -loseXp, getCurrentSeason());
      }
      userRepo.addLoss(player.user_id);
      if (isCashMatch) {
        userRepo.addEntered(player.user_id, challenge.entry_amount_usdc);
      }
    } catch (err) {
      console.error(`[MatchService] Failed to update stats for loser ${player.user_id}:`, err.message);
    }

    // Sync to NeatQueue: points (if any) + loss
    if (neatqueueService.isConfigured()) {
      const loseUser = userRepo.findById(player.user_id);
      if (loseUser) {
        // For cash matches: 0 XP loss (no point change), but still record the loss
        // For XP matches: subtract the ELO-calculated points
        if (loseXp > 0) {
          neatqueueService.addPoints(loseUser.discord_id, -loseXp).catch(err => {
            console.error(`[MatchService] NeatQueue points failed for loser ${loseUser.discord_id}:`, err.message);
          });
        }
        neatqueueService.addLoss(loseUser.discord_id).catch(err => {
          console.error(`[MatchService] NeatQueue loss failed for ${loseUser.discord_id}:`, err.message);
        });
      }
    }
  }

  // Log resolution to admin feed
  const { postTransaction: postTx } = require('../utils/transactionFeed');
  const winnerNames = winningPlayers.map(p => { const u = userRepo.findById(p.user_id); return u?.server_username || '?'; }).join(', ');
  const loserNames = losingPlayers.map(p => { const u = userRepo.findById(p.user_id); return u?.server_username || '?'; }).join(', ');
  const isCashMatch2 = challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0;
  postTx({ type: 'match_resolved', challengeId: match.challenge_id, memo: `Match #${matchId} | Team ${winningTeam} wins\nWinners: ${winnerNames} (+${winXp} XP${isCashMatch2 ? `, +$${(Number(perPlayerEarnings) / 1000000).toFixed(2)} each` : ''})\nLosers: ${loserNames} (${loseXp > 0 ? `-${loseXp} XP` : '0 XP'})` });

  // Log each XP award
  for (const player of winningPlayers) {
    const u = userRepo.findById(player.user_id);
    if (u) postTx({ type: 'xp_awarded', username: u.server_username, discordId: u.discord_id, challengeId: match.challenge_id, memo: `+${winXp} XP (win) | Total: ${u.xp_points} XP` });
  }
  for (const player of losingPlayers) {
    if (loseXp > 0) {
      const u = userRepo.findById(player.user_id);
      if (u) postTx({ type: 'xp_awarded', username: u.server_username, discordId: u.discord_id, challengeId: match.challenge_id, memo: `-${loseXp} XP (loss) | Total: ${u.xp_points} XP` });
    }
  }

  // Send result message in shared channel (in first captain's language)
  if (match.shared_text_id) {
    try {
      const sharedChannel = client.channels.cache.get(match.shared_text_id);
      if (sharedChannel) {
        const isCashMatchResult = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
        // Get captain languages for the shared message
        const allCaptains = allPlayers.filter(p => p.role === PLAYER_ROLE.CAPTAIN);
        const captainDiscordIdsForLang = allCaptains.map(p => {
          const u = userRepo.findById(p.user_id);
          return u ? u.discord_id : null;
        }).filter(Boolean);
        const sharedLang = _captainLang(captainDiscordIdsForLang);
        const prizeAmount = (Number(challenge.total_pot_usdc) / 1_000_000).toFixed(2);
        const prizeText = isCashMatchResult
          ? t('match_channel.result_pot_distributed', sharedLang, { amount: prizeAmount })
          : '';

        const resultLangRow = buildLanguageDropdownRow(sharedLang);
        await sharedChannel.send({
          content: [
            t('match_channel.result_complete', sharedLang, { matchId }),
            '',
            t('match_channel.result_winner', sharedLang, { team: winningTeam }),
            prizeText,
            '',
            t('match_channel.result_cleanup', sharedLang),
          ].join('\n'),
          components: [resultLangRow],
        });
      }
    } catch (err) {
      console.error(`[MatchService] Failed to send result message for match #${matchId}:`, err.message);
    }
  }

  // Build the result embed (shared between channels)
  const { EmbedBuilder } = require('discord.js');
  const { GAME_MODES } = require('../config/constants');

  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
  const matchPrize = Number(challenge.total_pot_usdc);
  const entryAmount = Number(challenge.entry_amount_usdc);
  const perPlayerPayout = matchPrize > 0 ? matchPrize / winningPlayers.length : 0;
  const perPlayerProfit = perPlayerPayout - entryAmount;
  const displayWinXp = match._winXp || winXp;
  const displayLoseXp = match._loseXp || loseXp;
  const matchTypeLabel = isCashMatch ? 'Cash Match' : 'XP Match';

  const winnerLines = [];
  for (const p of winningPlayers) {
    const u = userRepo.findById(p.user_id);
    if (!u) continue;
    const ign = u.cod_ign ? `(${u.cod_ign})` : '';
    const moneyText = isCashMatch ? `**+${formatUsdc(perPlayerProfit)} USDC** ` : '';
    winnerLines.push(`<@${u.discord_id}> ${ign} — ${moneyText}+${displayWinXp} XP`);
  }
  const loserLines = [];
  for (const p of losingPlayers) {
    const u = userRepo.findById(p.user_id);
    if (!u) continue;
    const ign = u.cod_ign ? `(${u.cod_ign})` : '';
    const moneyText = isCashMatch ? `**-${formatUsdc(entryAmount)} USDC** ` : '';
    const xpText = displayLoseXp > 0 ? `-${displayLoseXp} XP` : '';
    loserLines.push(`<@${u.discord_id}> ${ign} — ${moneyText}${xpText}`);
  }

  const titleLine = isCashMatch
    ? `**Team ${winningTeam} wins! Match Prize: ${formatUsdc(matchPrize)} USDC**`
    : `**Team ${winningTeam} wins!**`;

  const resultEmbed = new EmbedBuilder()
    .setTitle(`${matchTypeLabel} #${matchId} — Result`)
    .setColor(isCashMatch ? 0xf1c40f : 0x3498db)
    .setDescription([titleLine, '', '**Winners**', ...winnerLines, '', '**Losers**', ...loserLines].join('\n'))
    .addFields(
      { name: 'Mode', value: modeLabel, inline: true },
      { name: 'Series', value: `Best of ${challenge.series_length}`, inline: true },
      { name: 'Team Size', value: `${challenge.team_size}v${challenge.team_size}`, inline: true },
    )
    .setTimestamp();

  if (isCashMatch) {
    resultEmbed.addFields({ name: 'Entry', value: `${formatUsdc(entryAmount)} per player`, inline: true });
  }

  // Inline language dropdown — user picks a language and gets an ephemeral
  // of this specific result in that language.
  const { ActionRowBuilder } = require('discord.js');
  const { buildResultLanguageDropdown } = require('../interactions/perMessageLanguage');
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const resultDisplayLang = getBotDisplayLanguage();
  const langRow = buildResultLanguageDropdown(matchId, resultDisplayLang);

  // Post to the regular results channels (all-results + cash-match-results).
  // Routed through postResultToChannels so the cache-miss / fetch fallback
  // applies — these are low-traffic admin channels and frequently fall
  // out of the channels cache after a restart.
  await postResultToChannels(client, resultEmbed, [langRow], isCashMatch, matchId);

  // Update nicknames with new XP and earnings
  const { updateNicknames } = require('../utils/nicknameUpdater');
  const allPlayerIds = allPlayers.map(p => p.user_id);
  updateNicknames(client, allPlayerIds).catch(err => {
    console.error(`[MatchService] Nickname update failed:`, err.message);
  });

  // Sync rank roles for every match participant — the match may
  // have bumped someone into a new tier (or knocked them out of
  // the Crowned top 10).
  const { syncRanks } = require('../utils/rankRoleSync');
  syncRanks(client, allPlayerIds).catch(err => {
    console.error(`[MatchService] Rank role sync failed:`, err.message);
  });

  // Schedule channel cleanup after 5 minutes
  setTimeout(() => {
    cleanupChannels(client, matchId).catch(err => {
      console.error(`[MatchService] Error during scheduled cleanup for match #${matchId}:`, err.message);
    });
  }, 5 * 60 * 1000);

  console.log(`[MatchService] Match #${matchId} resolved. Team ${winningTeam} wins.`);
}

/**
 * Clean up match channels after a match is completed or cancelled.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} matchId - The match ID.
 */
async function cleanupChannels(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match) {
    console.error(`[MatchService] Match ${matchId} not found for cleanup`);
    return;
  }

  const channelIds = [
    match.team1_text_id,
    match.team1_voice_id,
    match.team2_text_id,
    match.team2_voice_id,
    match.shared_text_id,
    match.shared_voice_id,
    match.voting_channel_id,
  ];

  // Delete all channels
  for (const channelId of channelIds) {
    if (!channelId) continue;
    try {
      const channel = client.channels.cache.get(channelId);
      if (channel && channel.deletable) {
        await channel.delete('Match cleanup');
      }
    } catch (err) {
      console.error(`[MatchService] Failed to delete channel ${channelId}:`, err.message);
    }
  }

  // Delete the category
  if (match.category_id) {
    try {
      const category = client.channels.cache.get(match.category_id);
      if (category && category.deletable) {
        await category.delete('Match cleanup');
      }
    } catch (err) {
      console.error(`[MatchService] Failed to delete category ${match.category_id}:`, err.message);
    }
  }

  console.log(`[MatchService] Cleaned up channels for match #${matchId}`);
}

/**
 * Check which players are NOT in any of the match voice channels.
 */
function getPlayersNotInVoice(client, match, playerDiscordIds) {
  const voiceChannelIds = [match.team1_voice_id, match.team2_voice_id, match.shared_voice_id].filter(Boolean);
  const inVoice = new Set();

  for (const vcId of voiceChannelIds) {
    const vc = client.channels.cache.get(vcId);
    if (vc && vc.members) {
      for (const [memberId] of vc.members) {
        inVoice.add(memberId);
      }
    }
  }

  return playerDiscordIds.filter(id => !inVoice.has(id));
}

/**
 * Start no-show reminder pings at 5min and 10min after match creation.
 * Checks if players have joined any match voice channel.
 */
function startNoShowReminders(client, match, playerDiscordIds) {
  const sharedChannelId = match.shared_text_id;
  if (!sharedChannelId) return;

  // For no-show reminders, use the first absent player's language as the message language.
  // (Mentioning multiple users in different languages would be cluttered — pick one.)
  const reminderLang = () => {
    const notInVoice = getPlayersNotInVoice(client, match, playerDiscordIds);
    return notInVoice.length > 0 ? getLang(notInVoice[0]) : 'en';
  };

  // 5 minute reminder
  setTimeout(async () => {
    try {
      const currentMatch = matchRepo.findById(match.id);
      if (!currentMatch || currentMatch.status !== MATCH_STATUS.ACTIVE) return;

      const notInVoice = getPlayersNotInVoice(client, currentMatch, playerDiscordIds);
      if (notInVoice.length === 0) return;

      const ch = client.channels.cache.get(sharedChannelId);
      if (ch) {
        const pings = notInVoice.map(id => `<@${id}>`).join(' ');
        const lang = reminderLang();
        await ch.send({ content: t('match_channel.no_show_warning_5', lang, { pings }), components: [buildLanguageDropdownRow(lang)] });
      }
    } catch (err) {
      console.error(`[MatchService] No-show reminder (5min) failed:`, err.message);
    }
  }, 5 * 60 * 1000);

  // 10 minute reminder
  setTimeout(async () => {
    try {
      const currentMatch = matchRepo.findById(match.id);
      if (!currentMatch || currentMatch.status !== MATCH_STATUS.ACTIVE) return;

      const notInVoice = getPlayersNotInVoice(client, currentMatch, playerDiscordIds);
      if (notInVoice.length === 0) return;

      const ch = client.channels.cache.get(sharedChannelId);
      if (ch) {
        const pings = notInVoice.map(id => `<@${id}>`).join(' ');
        const lang = reminderLang();
        await ch.send({ content: t('match_channel.no_show_warning_10', lang, { pings }), components: [buildLanguageDropdownRow(lang)] });
      }
    } catch (err) {
      console.error(`[MatchService] No-show reminder (10min) failed:`, err.message);
    }
  }, 10 * 60 * 1000);
}

module.exports = { createMatchChannels, startMatch, resolveMatch, cleanupChannels, postResultToChannels };

// Captain voting phase — players vote for 2 captains, top 2 are selected.
//
// Depends on state.js for match/client access. Calls into captainPick.js
// after the vote is finalized to begin the draft phase.

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const { setClient, getMatch } = require('./state');

/**
 * Begin captain voting. Each player votes for 2 players they want as captain.
 * Top 2 vote-getters become captains. Ties broken by XP, then random.
 * @param {object} match — The QueueMatch object.
 * @param {import('discord.js').Client} client — Discord client.
 * @returns {Promise<void>}
 */
async function startCaptainVote(match, client) {
  match.phase = 'CAPTAIN_VOTE';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  if (client) setClient(client);
  const _client = setClient();
  console.log(`[QueueService] Match #${match.id} entering CAPTAIN_VOTE phase`);

  const textChannel = (_client || {}).channels?.cache?.get(match.textChannelId);
  if (!textChannel) {
    console.error(`[QueueService] Text channel not found for match #${match.id}`);
    return;
  }

  // Build player options for the select menu
  const playerOptions = [...match.players.values()].map(p => {
    const user = userRepo.findByDiscordId(p.discordId);
    const name = user?.display_name || p.discordId;
    const xpStr = (p.xp || 0).toLocaleString();
    return {
      label: `${name} (${xpStr} XP)`,
      value: p.discordId,
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`queue_captain_vote_${match.id}`)
    .setPlaceholder('Vote for 2 captains...')
    .setMinValues(2)
    .setMaxValues(2)
    .addOptions(playerOptions);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const embed = new EmbedBuilder()
    .setTitle('Captain Vote')
    .setColor(0xf1c40f)
    .setDescription([
      'Vote for **2 players** you want as captain.',
      'You **cannot** vote for yourself.',
      '',
      `Time: **${QUEUE_CONFIG.CAPTAIN_VOTE_TIMEOUT / 1000}s** — if you don't vote, the highest XP players will be chosen.`,
    ].join('\n'));

  match._captainVoteMsg = await textChannel.send({ embeds: [embed], components: [row] });

  // Start timer — when it expires, finalize with whatever votes we have
  match.timer = setTimeout(async () => {
    try {
      await finalizeCaptainVote(match);
    } catch (err) {
      console.error(`[QueueService] finalizeCaptainVote timer failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.CAPTAIN_VOTE_TIMEOUT);
}

/**
 * Record a captain vote (2 picks).
 * @param {number} matchId — Match ID.
 * @param {string} voterId — Discord ID of the voter.
 * @param {string[]} votedForIds — Array of 2 Discord IDs voted for.
 * @returns {{ success: boolean, allVoted?: boolean, error?: string }}
 */
function recordCaptainVote(matchId, voterId, votedForIds) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'CAPTAIN_VOTE') return { success: false, error: 'Not in captain vote phase' };
  if (!match.players.has(voterId)) return { success: false, error: 'Not a player in this match' };

  // votedForIds is an array of 2 discord IDs
  if (!Array.isArray(votedForIds) || votedForIds.length !== 2) {
    return { success: false, error: 'Must vote for exactly 2 players' };
  }
  if (votedForIds.includes(voterId)) {
    return { success: false, error: 'You cannot vote for yourself' };
  }
  for (const id of votedForIds) {
    if (!match.players.has(id)) return { success: false, error: 'Voted player not in this match' };
  }

  match.captainVotes.set(voterId, votedForIds);

  // Check if all players have voted
  const allVoted = match.captainVotes.size >= match.players.size;
  return { success: true, allVoted };
}

/**
 * Tally votes and assign the top 2 captains. Tiebreak: XP desc, then random.
 * After selecting captains, proceeds to the captain pick phase.
 * @param {object} match — The QueueMatch object.
 * @returns {Promise<void>}
 */
async function finalizeCaptainVote(match) {
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} finalizing captain vote`);

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  // Disable the vote select menu
  if (match._captainVoteMsg) {
    try {
      const disabledRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`queue_captain_vote_${match.id}_done`)
          .setPlaceholder('Voting closed')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions({ label: 'Closed', value: 'closed' })
          .setDisabled(true),
      );
      await match._captainVoteMsg.edit({ components: [disabledRow] });
    } catch { /* message may be gone */ }
    delete match._captainVoteMsg;
  }

  // Tally votes — each vote is an array of 2 discord IDs
  const tally = new Map(); // discordId → vote count
  for (const [, p] of match.players) {
    tally.set(p.discordId, 0);
  }
  for (const [, votedForIds] of match.captainVotes) {
    const ids = Array.isArray(votedForIds) ? votedForIds : [votedForIds];
    for (const id of ids) {
      tally.set(id, (tally.get(id) || 0) + 1);
    }
  }

  // Sort by votes DESC, then XP DESC, then stable random tiebreak.
  // Assign a random tiebreak value ONCE per entry before sorting —
  // Math.random() inside a comparator violates the sort contract
  // (transitivity) and produces biased results with TimSort.
  const sorted = [...tally.entries()]
    .map(([discordId, votes]) => {
      const player = match.players.get(discordId);
      return { discordId, votes, xp: player?.xp || 0, tiebreak: Math.random() };
    })
    .sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      if (b.xp !== a.xp) return b.xp - a.xp;
      return a.tiebreak - b.tiebreak;
    });

  const captain1Id = sorted[0].discordId;
  const captain2Id = sorted[1].discordId;

  // Assign captains
  match.captains = { team1: captain1Id, team2: captain2Id };
  const cap1Player = match.players.get(captain1Id);
  const cap2Player = match.players.get(captain2Id);
  cap1Player.team = 1;
  cap1Player.isCaptain = true;
  cap2Player.team = 2;
  cap2Player.isCaptain = true;
  match.team1 = [captain1Id];
  match.team2 = [captain2Id];

  // Post result
  if (textChannel) {
    const embed = new EmbedBuilder()
      .setTitle('Captains Selected')
      .setColor(0x2ecc71)
      .setDescription([
        `**Captain 1 (Team 1):** <@${captain1Id}> (${sorted[0].votes} votes, ${sorted[0].xp.toLocaleString()} XP)`,
        `**Captain 2 (Team 2):** <@${captain2Id}> (${sorted[1].votes} votes, ${sorted[1].xp.toLocaleString()} XP)`,
      ].join('\n'));
    await textChannel.send({ embeds: [embed] });
  }

  // Proceed to captain pick (lazy require to avoid circular dependency)
  const { startCaptainPick } = require('./captainPick');
  await startCaptainPick(match);
}

module.exports = {
  startCaptainVote,
  recordCaptainVote,
  finalizeCaptainVote,
};

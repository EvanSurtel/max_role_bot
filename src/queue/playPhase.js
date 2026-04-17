// Play phase — display match info, start play timer, handle captain result voting.
//
// Depends on state.js for match/client access. Calls into matchLifecycle.js
// to resolve the match after both captains agree on the result.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const { setClient, getMatch } = require('./state');
const { pickMaps } = require('../utils/mapPicker');

/**
 * Display match info (teams, roles, operators, maps) and start the play timer.
 * Captains can report results. Staff can sub/DQ.
 * @param {object} match — The QueueMatch object.
 * @returns {Promise<void>}
 */
async function startPlayPhase(match) {
  match.phase = 'PLAYING';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering PLAYING phase`);

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (!textChannel) return;

  // Pick maps — always HP Bo3
  match.maps = pickMaps(QUEUE_CONFIG.GAME_MODE, QUEUE_CONFIG.SERIES_LENGTH);

  // Build team roster lines
  function teamRoster(teamNum) {
    const teamArr = teamNum === 1 ? match.team1 : match.team2;
    return teamArr.map(id => {
      const p = match.players.get(id);
      const roles = p.weaponRoles.length > 0 ? p.weaponRoles.join('/') : 'N/A';
      const op = p.operator || 'N/A';
      const capTag = p.isCaptain ? ' (C)' : '';
      return `<@${id}>${capTag} — ${roles} — ${op}`;
    }).join('\n');
  }

  const mapList = match.maps.map(m => `${m.game}. ${m.map}`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`5v5 Ranked Queue -- Match #${match.id}`)
    .setColor(0x2ecc71)
    .setDescription([
      `**Team 1** (Captain: <@${match.captains.team1}>)`,
      teamRoster(1),
      '',
      `**Team 2** (Captain: <@${match.captains.team2}>)`,
      teamRoster(2),
      '',
      `**Maps (Bo${QUEUE_CONFIG.SERIES_LENGTH} Hardpoint)**`,
      mapList,
      '',
      '**Good luck! Report results below after 10 minutes.**',
    ].join('\n'))
    .setTimestamp();

  // Report buttons (captains only)
  const reportRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_report_${match.id}_1`)
      .setLabel('Team 1 Won')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`queue_report_${match.id}_2`)
      .setLabel('Team 2 Won')
      .setStyle(ButtonStyle.Danger),
  );

  // Admin sub/DQ buttons
  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_sub_fresh_${match.id}`)
      .setLabel('Sub Player (Fresh)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`queue_sub_mid_${match.id}`)
      .setLabel('Sub Player (Mid-Series)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`queue_dq_${match.id}`)
      .setLabel('DQ Player (-300 XP)')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`queue_cancel_${match.id}`)
      .setLabel('Cancel Match')
      .setStyle(ButtonStyle.Danger),
  );

  match._matchMsg = await textChannel.send({ embeds: [embed], components: [reportRow, adminRow] });

  // 10-minute play timer — just a reminder
  match.timer = setTimeout(async () => {
    try {
      const tc = _client?.channels?.cache?.get(match.textChannelId);
      if (tc && match.phase === 'PLAYING') {
        await tc.send({ content: "Time's up! Captains, report the result using the buttons above." });
      }
    } catch (err) {
      console.error(`[QueueService] Play reminder failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.PLAY_TIMEOUT);
}

/**
 * Record a captain's vote for the winning team.
 * Accepts votes during PLAYING or VOTING phase (first vote transitions to VOTING).
 * @param {number} matchId — Match ID.
 * @param {string} captainDiscordId — Discord ID of the voting captain.
 * @param {number} winningTeam — 1 or 2.
 * @returns {{ success: boolean, allVoted?: boolean, agreed?: boolean, winningTeam?: number, error?: string }}
 */
function recordVote(matchId, captainDiscordId, winningTeam) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'PLAYING' && match.phase !== 'VOTING') {
    return { success: false, error: 'Not in playing/voting phase' };
  }

  const isCap1 = captainDiscordId === match.captains.team1;
  const isCap2 = captainDiscordId === match.captains.team2;
  if (!isCap1 && !isCap2) {
    return { success: false, error: 'Only captains can report results' };
  }

  // Transition to VOTING on first vote
  if (match.phase === 'PLAYING') {
    match.phase = 'VOTING';
  }

  if (isCap1) match.captain1Vote = winningTeam;
  else match.captain2Vote = winningTeam;

  const allVoted = match.captain1Vote !== null && match.captain2Vote !== null;
  const agreed = allVoted && match.captain1Vote === match.captain2Vote;

  return {
    success: true,
    allVoted,
    agreed,
    winningTeam: agreed ? match.captain1Vote : null,
  };
}

module.exports = {
  startPlayPhase,
  recordVote,
};

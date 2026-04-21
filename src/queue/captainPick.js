// Captain pick (draft) phase — captains alternate picking players in snake order.
//
// Depends on state.js for match/client access. Calls into roleSelect.js
// after all picks are complete to begin the role selection phase.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const { setClient, getMatch, save: saveMatch } = require('./state');

/**
 * Begin pick phase. Random first pick; captains alternate (snake draft).
 * Snake draft order for 8 picks: C1, C2, C2, C1, C1, C2, C2, C1
 * @param {object} match — The QueueMatch object.
 * @returns {Promise<void>}
 */
async function startCaptainPick(match) {
  match.phase = 'CAPTAIN_PICK';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering CAPTAIN_PICK phase`);

  // Randomly decide who picks first
  const firstPicker = Math.random() < 0.5 ? match.captains.team1 : match.captains.team2;
  const secondPicker = firstPicker === match.captains.team1 ? match.captains.team2 : match.captains.team1;

  // Snake draft: 1-2-2-1-1-2-2-1 for 8 picks
  match.pickOrder = [
    firstPicker,
    secondPicker, secondPicker,
    firstPicker, firstPicker,
    secondPicker, secondPicker,
    firstPicker,
  ];
  match._pickIndex = 0;
  match.currentPicker = match.pickOrder[0];
  saveMatch(match);

  await _postPickMessage(match);
}

// Post or update the captain pick message with buttons for remaining players.
async function _postPickMessage(match) {
  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (!textChannel) return;

  const unpicked = [...match.players.values()].filter(p => !p.team);
  const pickerTeam = match.players.get(match.currentPicker)?.team;
  const teamLabel = pickerTeam === 1 ? 'Team 1' : 'Team 2';

  const embed = new EmbedBuilder()
    .setTitle('Captain Pick Phase')
    .setColor(0x3498db)
    .setDescription([
      `<@${match.currentPicker}> (**${teamLabel}**) — pick a player!`,
      '',
      `**Remaining players (${unpicked.length}):**`,
      ...unpicked.map(p => `- <@${p.discordId}> — ${(p.xp || 0).toLocaleString()} XP`),
      '',
      `Pick ${match._pickIndex + 1} of ${match.pickOrder.length} | Time: **${QUEUE_CONFIG.CAPTAIN_PICK_TIMEOUT / 1000}s**`,
    ].join('\n'));

  // Build button rows (up to 5 per row)
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount = 0;

  for (const p of unpicked) {
    const user = userRepo.findByDiscordId(p.discordId);
    const name = user?.display_name || p.discordId.slice(0, 15);
    const xpStr = (p.xp || 0).toLocaleString();

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_pick_${match.id}_${p.discordId}`)
        .setLabel(`${name} (${xpStr} XP)`)
        .setStyle(ButtonStyle.Primary),
    );
    btnCount++;

    if (btnCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  // Edit existing message or send new one
  if (match._pickMsg) {
    try {
      await match._pickMsg.edit({ embeds: [embed], components: rows });
    } catch {
      match._pickMsg = await textChannel.send({ embeds: [embed], components: rows });
    }
  } else {
    match._pickMsg = await textChannel.send({ embeds: [embed], components: rows });
  }

  // Start pick timer
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  match.timer = setTimeout(async () => {
    try {
      await _handlePickTimeout(match);
    } catch (err) {
      console.error(`[QueueService] Pick timeout failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.CAPTAIN_PICK_TIMEOUT);
}

// Handle pick timeout — auto-pick highest XP remaining player.
async function _handlePickTimeout(match) {
  if (match.phase !== 'CAPTAIN_PICK' || !match.currentPicker) return;

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  autoPickForCaptain(match);

  const lastPicked = [...match.players.values()]
    .filter(p => p.team && !p.isCaptain)
    .sort((a, b) => b.xp - a.xp)[0];

  if (textChannel && lastPicked) {
    await textChannel.send({
      content: `Auto-picked <@${lastPicked.discordId}> (highest XP available) for <@${match.currentPicker}>`,
    });
  }

  await _advancePick(match);
}

/**
 * Record a captain pick.
 * @param {number} matchId — Match ID.
 * @param {string} captainId — Discord ID of the picking captain.
 * @param {string} pickedPlayerId — Discord ID of the picked player.
 * @returns {{ success: boolean, error?: string }}
 */
function recordCaptainPick(matchId, captainId, pickedPlayerId) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'CAPTAIN_PICK') return { success: false, error: 'Not in captain pick phase' };
  if (match.currentPicker !== captainId) return { success: false, error: 'Not your turn to pick' };
  if (!match.players.has(pickedPlayerId)) return { success: false, error: 'Player not in this match' };

  const player = match.players.get(pickedPlayerId);
  if (player.team) return { success: false, error: 'Player already on a team' };

  // Assign to picker's team
  const pickerPlayer = match.players.get(captainId);
  player.team = pickerPlayer.team;
  if (player.team === 1) match.team1.push(pickedPlayerId);
  else match.team2.push(pickedPlayerId);

  // Clear currentPicker BEFORE returning so a second spam-click from the
  // same captain (on a different player) fails the `currentPicker !==
  // captainId` guard above. Without this, the captain can double-pick
  // in the ~50-200 ms window between this function returning and
  // _advancePick running (the button handler does a textChannel.send +
  // deferUpdate after recordCaptainPick — both yield the event loop
  // before _advancePick updates currentPicker to the next captain).
  // _advancePick overwrites match.currentPicker unconditionally, so
  // clobbering it to null here is safe.
  match.currentPicker = null;

  saveMatch(match);
  return { success: true };
}

// Advance to the next pick in the snake draft, or move to role select if done.
async function _advancePick(match) {
  match._pickIndex = (match._pickIndex || 0) + 1;

  // Check if all picks are done
  const unpicked = [...match.players.values()].filter(p => !p.team);
  if (unpicked.length === 0 || match._pickIndex >= match.pickOrder.length) {
    // All players picked — disable the pick message and move on
    if (match._pickMsg) {
      try {
        await match._pickMsg.edit({ components: [] });
      } catch { /* */ }
      delete match._pickMsg;
    }
    if (match.timer) { clearTimeout(match.timer); match.timer = null; }

    // Lazy require to avoid circular dependency
    const { startRoleSelect } = require('./roleSelect');
    await startRoleSelect(match);
    return;
  }

  // Advance to next captain in the pick order
  match.currentPicker = match.pickOrder[match._pickIndex];
  saveMatch(match);
  await _postPickMessage(match);
}

/**
 * Auto-pick highest XP remaining player. Called when captain timer expires.
 * @param {object} match — The QueueMatch object.
 * @returns {void}
 */
function autoPickForCaptain(match) {
  if (!match.currentPicker) return;
  const pickerTeam = match.players.get(match.currentPicker)?.team;
  if (!pickerTeam) return;

  // Find unpicked players (no team assignment, not a captain)
  const unpicked = [...match.players.values()]
    .filter(p => !p.team)
    .sort((a, b) => b.xp - a.xp);

  if (unpicked.length === 0) return;

  const picked = unpicked[0];
  picked.team = pickerTeam;
  if (pickerTeam === 1) match.team1.push(picked.discordId);
  else match.team2.push(picked.discordId);

  console.log(`[QueueService] Auto-picked ${picked.discordId} for team ${pickerTeam} in match #${match.id}`);
}

module.exports = {
  startCaptainPick,
  recordCaptainPick,
  autoPickForCaptain,
  _advancePick,
  _postPickMessage,
};

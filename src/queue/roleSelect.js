// Weapon role and operator selection phase — each player picks roles and an operator.
//
// Depends on state.js for match/client access. Calls into playPhase.js
// after all players have completed their selections (or timer expires).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const { setClient, getMatch, save: saveMatch } = require('./state');

/**
 * Begin role selection. Each team gets a message with weapon role + operator buttons.
 * Players pick up to 2 weapon roles and 1 operator.
 * @param {object} match — The QueueMatch object.
 * @returns {Promise<void>}
 */
async function startRoleSelect(match) {
  match.phase = 'ROLE_SELECT';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering ROLE_SELECT phase`);

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (!textChannel) return;

  // Initialize role counters
  match.team1Roles = new Map();
  match.team2Roles = new Map();
  match.team1Operators = new Map();
  match.team2Operators = new Map();
  saveMatch(match);

  // Post a message for each team
  for (const teamNum of [1, 2]) {
    const msg = await _postRoleSelectMessage(match, teamNum, textChannel);
    if (teamNum === 1) match._roleMsg1 = msg;
    else match._roleMsg2 = msg;
  }

  // Start timer
  match.timer = setTimeout(async () => {
    try {
      await _handleRoleTimeout(match);
    } catch (err) {
      console.error(`[QueueService] Role select timeout failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.ROLE_SELECT_TIMEOUT);
}

// Build and post (or edit) the role selection message for one team.
async function _postRoleSelectMessage(match, teamNum, textChannel) {
  const teamPlayers = [...match.players.values()].filter(p => p.team === teamNum);
  const teamRoles = teamNum === 1 ? match.team1Roles : match.team2Roles;
  const teamOps = teamNum === 1 ? match.team1Operators : match.team2Operators;
  const captainId = teamNum === 1 ? match.captains.team1 : match.captains.team2;

  // Player status lines
  const playerLines = teamPlayers.map(p => {
    const roles = p.weaponRoles.length > 0 ? p.weaponRoles.join('/') : '_none_';
    const op = p.operator || '_none_';
    return `<@${p.discordId}> — Roles: **${roles}** | Operator: **${op}**`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Team ${teamNum} — Role Selection`)
    .setColor(teamNum === 1 ? 0x3498db : 0xe74c3c)
    .setDescription([
      `Captain: <@${captainId}>`,
      '',
      playerLines,
      '',
      `Pick **up to 2 weapon roles** and **1 operator**. Time: **${QUEUE_CONFIG.ROLE_SELECT_TIMEOUT / 1000}s**`,
    ].join('\n'));

  // Row 1: AR, SMG, LMG
  const weaponRow1 = new ActionRowBuilder();
  for (const roleKey of ['AR', 'SMG', 'LMG']) {
    const cfg = QUEUE_CONFIG.WEAPON_ROLES[roleKey];
    const count = teamRoles.get(roleKey) || 0;
    const isFull = count >= cfg.max;
    weaponRow1.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_role_${match.id}_${teamNum}_${roleKey}`)
        .setLabel(`${cfg.emoji} ${cfg.label} (${count}/${cfg.max})`)
        .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(isFull),
    );
  }

  // Row 2: Shotgun, Marksman, Sniper
  const weaponRow2 = new ActionRowBuilder();
  for (const roleKey of ['SHOTGUN', 'MARKSMAN', 'SNIPER']) {
    const cfg = QUEUE_CONFIG.WEAPON_ROLES[roleKey];
    const count = teamRoles.get(roleKey) || 0;
    const isFull = count >= cfg.max;
    weaponRow2.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_role_${match.id}_${teamNum}_${roleKey}`)
        .setLabel(`${cfg.emoji} ${cfg.label} (${count}/${cfg.max})`)
        .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(isFull),
    );
  }

  // Row 3: First 5 operators
  const ops1 = QUEUE_CONFIG.OPERATORS.slice(0, 5);
  const opRow1 = new ActionRowBuilder();
  for (const op of ops1) {
    const taken = teamOps.has(op);
    opRow1.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_op_${match.id}_${teamNum}_${op.replace(/\s+/g, '_')}`)
        .setLabel(taken ? `${op} (taken)` : op)
        .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(taken),
    );
  }

  // Row 4: Last 5 operators
  const ops2 = QUEUE_CONFIG.OPERATORS.slice(5, 10);
  const opRow2 = new ActionRowBuilder();
  for (const op of ops2) {
    const taken = teamOps.has(op);
    opRow2.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_op_${match.id}_${teamNum}_${op.replace(/\s+/g, '_')}`)
        .setLabel(taken ? `${op} (taken)` : op)
        .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(taken),
    );
  }

  const payload = { embeds: [embed], components: [weaponRow1, weaponRow2, opRow1, opRow2] };

  // Edit existing or send new
  const existingMsg = teamNum === 1 ? match._roleMsg1 : match._roleMsg2;
  if (existingMsg) {
    try {
      await existingMsg.edit(payload);
      return existingMsg;
    } catch { /* send new */ }
  }
  return await textChannel.send(payload);
}

// Handle role selection timeout — auto-assign remaining roles and operators.
async function _handleRoleTimeout(match) {
  if (match.phase !== 'ROLE_SELECT') return;
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  // Auto-assign weapon roles for players who haven't chosen
  autoAssignRoles(match);

  // Auto-assign operators for players who haven't chosen
  _autoAssignOperators(match);

  // Post summary
  if (textChannel) {
    await textChannel.send({
      content: 'Role selection time expired. Remaining roles and operators have been auto-assigned.',
    });
  }

  // Disable role select messages
  for (const msg of [match._roleMsg1, match._roleMsg2]) {
    if (msg) try { await msg.edit({ components: [] }); } catch { /* */ }
  }
  delete match._roleMsg1;
  delete match._roleMsg2;

  // Lazy require to avoid circular dependency
  const { startPlayPhase } = require('./playPhase');
  await startPlayPhase(match);
}

// Auto-assign operators to players who didn't pick one.
function _autoAssignOperators(match) {
  for (const teamNum of [1, 2]) {
    const teamOps = teamNum === 1 ? match.team1Operators : match.team2Operators;
    const teamPlayers = [...match.players.values()].filter(p => p.team === teamNum);
    const unassigned = teamPlayers.filter(p => !p.operator);

    for (const player of unassigned) {
      const available = QUEUE_CONFIG.OPERATORS.filter(op => !teamOps.has(op));
      if (available.length === 0) break;
      const pick = available[Math.floor(Math.random() * available.length)];
      player.operator = pick;
      teamOps.set(pick, player.discordId);
      console.log(`[QueueService] Auto-assigned operator ${pick} to ${player.discordId} in match #${match.id}`);
    }
  }
}

/**
 * Record a weapon role choice (up to 2 per player).
 * @param {number} matchId — Match ID.
 * @param {string} discordId — Discord ID of the player.
 * @param {string} role — Weapon role key (e.g. 'AR', 'SMG').
 * @returns {{ success: boolean, error?: string }}
 */
function recordRoleChoice(matchId, discordId, role) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'ROLE_SELECT') return { success: false, error: 'Not in role select phase' };

  const player = match.players.get(discordId);
  if (!player) return { success: false, error: 'Not a player in this match' };

  const roleConfig = QUEUE_CONFIG.WEAPON_ROLES[role];
  if (!roleConfig) return { success: false, error: 'Invalid weapon role' };

  // Check player hasn't already picked 2 weapon roles
  if (player.weaponRoles.length >= 2) {
    return { success: false, error: 'You already picked 2 weapon roles' };
  }

  // Check if player already picked this exact role
  if (player.weaponRoles.includes(role)) {
    return { success: false, error: `You already picked ${roleConfig.label}` };
  }

  const teamRoles = player.team === 1 ? match.team1Roles : match.team2Roles;
  const currentCount = teamRoles.get(role) || 0;
  if (currentCount >= roleConfig.max) return { success: false, error: `${roleConfig.label} is full (max ${roleConfig.max})` };

  player.weaponRoles.push(role);
  teamRoles.set(role, currentCount + 1);

  saveMatch(match);
  return { success: true };
}

/**
 * Record an operator choice.
 * @param {number} matchId — Match ID.
 * @param {string} discordId — Discord ID of the player.
 * @param {string} operator — Operator name.
 * @returns {{ success: boolean, error?: string }}
 */
function recordOperatorChoice(matchId, discordId, operator) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'ROLE_SELECT') return { success: false, error: 'Not in role select phase' };

  const player = match.players.get(discordId);
  if (!player) return { success: false, error: 'Not a player in this match' };

  if (!QUEUE_CONFIG.OPERATORS.includes(operator)) {
    return { success: false, error: 'Invalid operator' };
  }

  const teamOps = player.team === 1 ? match.team1Operators : match.team2Operators;
  if (teamOps.has(operator) && teamOps.get(operator) !== discordId) {
    return { success: false, error: `${operator} is already taken by a teammate` };
  }

  // Remove previous operator if any
  if (player.operator) {
    const prevOps = player.team === 1 ? match.team1Operators : match.team2Operators;
    if (prevOps.get(player.operator) === discordId) {
      prevOps.delete(player.operator);
    }
  }

  player.operator = operator;
  teamOps.set(operator, discordId);

  saveMatch(match);
  return { success: true };
}

/**
 * Auto-assign remaining roles after timer expires. Uses AUTO_ROLE_PRIORITY
 * to fill players who have fewer than 2 weapon roles.
 * @param {object} match — The QueueMatch object.
 * @returns {void}
 */
function autoAssignRoles(match) {
  for (const teamNum of [1, 2]) {
    const teamRoles = teamNum === 1 ? match.team1Roles : match.team2Roles;
    const teamPlayers = [...match.players.values()].filter(p => p.team === teamNum);
    const needsRoles = teamPlayers.filter(p => p.weaponRoles.length < 2);

    for (const player of needsRoles) {
      while (player.weaponRoles.length < 2) {
        let assigned = false;
        for (const role of QUEUE_CONFIG.AUTO_ROLE_PRIORITY) {
          if (player.weaponRoles.includes(role)) continue;
          const config = QUEUE_CONFIG.WEAPON_ROLES[role];
          const current = teamRoles.get(role) || 0;
          if (current < config.max) {
            player.weaponRoles.push(role);
            teamRoles.set(role, current + 1);
            console.log(`[QueueService] Auto-assigned ${player.discordId} to ${role} in match #${match.id}`);
            assigned = true;
            break;
          }
        }
        // If no role could be assigned (all full), break out
        if (!assigned) break;
      }
    }
  }
}

/**
 * Check if all players have completed role + operator selection.
 * If so, skip the timer and proceed to play phase.
 * @param {object} match — The QueueMatch object.
 * @returns {void}
 */
function _checkAllRolesComplete(match) {
  const allPlayers = [...match.players.values()];
  const allDone = allPlayers.every(p => p.weaponRoles.length >= 2 && p.operator);
  if (allDone) {
    if (match.timer) { clearTimeout(match.timer); match.timer = null; }
    // Disable role select messages and proceed
    (async () => {
      for (const msg of [match._roleMsg1, match._roleMsg2]) {
        if (msg) try { await msg.edit({ components: [] }); } catch { /* */ }
      }
      delete match._roleMsg1;
      delete match._roleMsg2;

      // Lazy require to avoid circular dependency
      const { startPlayPhase } = require('./playPhase');
      await startPlayPhase(match);
    })().catch(err => {
      console.error(`[QueueService] Auto-proceed to play phase failed for match #${match.id}:`, err.message);
    });
  }
}

module.exports = {
  startRoleSelect,
  recordRoleChoice,
  recordOperatorChoice,
  autoAssignRoles,
  _autoAssignOperators,
  _postRoleSelectMessage,
  _checkAllRolesComplete,
};

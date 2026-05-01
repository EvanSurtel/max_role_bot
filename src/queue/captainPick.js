// Captain pick (draft) phase — captains alternate picking players in snake order.
//
// Depends on state.js for match/client access. Calls into roleSelect.js
// after all picks are complete to begin the role selection phase.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const { setClient, getMatch, save: saveMatch } = require('./state');

/**
 * Per-team voice channel permission overwrites — only members of
 * THIS team can connect/speak. Other queue match participants can
 * still see the channel exists (so they know where their opponents
 * are) but can't join. Staff get full access for moderation.
 */
function _teamVoiceOverwrites(guild, teamPlayerDiscordIds, otherTeamDiscordIds) {
  const overwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.MoveMembers,
      ],
    },
  ];

  // Team members: full join + speak.
  for (const id of teamPlayerDiscordIds) {
    overwrites.push({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  // Opposing team: can SEE the channel exists (so the category looks
  // complete, no mystery channels) but can't connect to listen in.
  for (const id of otherTeamDiscordIds) {
    overwrites.push({
      id,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    });
  }

  // Staff visibility + override
  const staffRoles = [
    process.env.WAGER_STAFF_ROLE_ID,
    process.env.XP_STAFF_ROLE_ID,
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
    process.env.CEO_ROLE_ID,
    process.env.ADS_ROLE_ID,
  ].filter(Boolean);
  for (const roleId of staffRoles) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.MoveMembers,
      ],
    });
  }

  return overwrites;
}

/**
 * Create per-team voice channels under the match category, then
 * delete the original lobby voice. Called from _advancePick when
 * the snake-draft completes and team rosters are final.
 *
 * Stores match.team1VoiceChannelId + match.team2VoiceChannelId so
 * later phases (and cleanup) can reference them.
 */
async function _createTeamVoiceChannels(match) {
  const client = setClient();
  if (!client) return;
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;

  const team1Ids = [...match.players.values()].filter(p => p.team === 1).map(p => p.discordId);
  const team2Ids = [...match.players.values()].filter(p => p.team === 2).map(p => p.discordId);

  // Create both team voices in parallel — they're independent.
  const [team1Voice, team2Voice] = await Promise.all([
    guild.channels.create({
      name: 'Team 1',
      type: ChannelType.GuildVoice,
      parent: match.categoryId,
      permissionOverwrites: _teamVoiceOverwrites(guild, team1Ids, team2Ids),
      reason: `Queue Match #${match.id} — Team 1 voice`,
    }),
    guild.channels.create({
      name: 'Team 2',
      type: ChannelType.GuildVoice,
      parent: match.categoryId,
      permissionOverwrites: _teamVoiceOverwrites(guild, team2Ids, team1Ids),
      reason: `Queue Match #${match.id} — Team 2 voice`,
    }),
  ]);

  match.team1VoiceChannelId = team1Voice.id;
  match.team2VoiceChannelId = team2Voice.id;

  // Move anyone currently in the lobby voice to their team voice.
  // Best-effort; a player without Move Members perms (none of them
  // do, but the bot might fail on hierarchy) just stays put — they
  // can rejoin manually.
  const lobby = client.channels.cache.get(match.voiceChannelId);
  if (lobby && lobby.members) {
    for (const [memberId, member] of lobby.members) {
      const targetVoice = team1Ids.includes(memberId) ? team1Voice
        : team2Ids.includes(memberId) ? team2Voice
        : null;
      if (targetVoice) {
        try { await member.voice.setChannel(targetVoice); } catch (mvErr) {
          console.warn(`[QueueService] Could not move ${memberId} to team voice: ${mvErr.message}`);
        }
      }
    }
  }

  // Delete the original lobby voice. Save match BEFORE deletion so
  // a restart mid-delete doesn't leave the activeMatches entry
  // pointing at a now-dead channel.
  const oldLobbyId = match.voiceChannelId;
  match.voiceChannelId = null; // Mark unset BEFORE delete so cleanup knows it's gone
  saveMatch(match);
  try {
    if (lobby) await lobby.delete(`Queue Match #${match.id} — lobby retired, teams split`);
  } catch (delErr) {
    console.warn(`[QueueService] Could not delete lobby voice ${oldLobbyId}: ${delErr.message}`);
  }

  // Tell the players in the text channel where their voice is.
  try {
    const tc = client.channels.cache.get(match.textChannelId);
    if (tc) {
      const team1Mentions = team1Ids.map(id => `<@${id}>`).join(' ');
      const team2Mentions = team2Ids.map(id => `<@${id}>`).join(' ');
      await tc.send({
        content: [
          '**Teams set — split into team voices:**',
          `**Team 1** → <#${team1Voice.id}>`,
          team1Mentions,
          '',
          `**Team 2** → <#${team2Voice.id}>`,
          team2Mentions,
        ].join('\n'),
        allowedMentions: { users: [...team1Ids, ...team2Ids] },
      });
    }
  } catch (notifyErr) {
    console.warn(`[QueueService] team-voice notification failed for match #${match.id}: ${notifyErr.message}`);
  }
}

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

    // Teams are decided — split the lobby voice into per-team voices.
    // Players can only join the team they're on. Original Queue Voice
    // lobby gets deleted so it doesn't sit there confusing people.
    try {
      await _createTeamVoiceChannels(match);
    } catch (splitErr) {
      console.error(`[QueueService] team-voice split failed for match #${match.id}:`, splitErr.message);
      // Don't block role-select on this — players just keep using the
      // shared lobby. Operator sees the error in the log.
    }

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

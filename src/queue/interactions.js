// Master interaction router + all button/select handlers for queue_* custom IDs.
//
// Every queue button press and select menu selection from interactionCreate.js
// lands here. Routes to the appropriate phase handler and manages Discord
// message updates. Depends on all other queue files for phase logic.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const { setClient, getMatch, waitingQueue } = require('./state');
const { _isStaffMember, findClosestXpReplacement } = require('./helpers');
const { recordCaptainVote, finalizeCaptainVote } = require('./captainVote');
const { recordCaptainPick, _advancePick } = require('./captainPick');
const { recordRoleChoice, recordOperatorChoice, _postRoleSelectMessage, _checkAllRolesComplete } = require('./roleSelect');
const { recordVote } = require('./playPhase');
const { resolveMatch } = require('./matchLifecycle');
const { subPlayerOut } = require('./subCommands');

/**
 * Master interaction handler — parse the customId prefix and route.
 * All queue_* button and select menu interactions land here.
 * @param {import('discord.js').Interaction} interaction — The Discord interaction.
 * @returns {Promise<void>}
 */
async function handleQueueInteraction(interaction) {
  const id = interaction.customId;
  const _client = setClient(interaction.client);

  // ── Captain vote select menu ────────────────────────────────
  if (id.startsWith('queue_captain_vote_')) {
    return await _handleCaptainVoteSelect(interaction);
  }

  // ── Captain pick button ─────────────────────────────────────
  if (id.startsWith('queue_pick_')) {
    return await _handleCaptainPickButton(interaction);
  }

  // ── Role select button ──────────────────────────────────────
  if (id.startsWith('queue_role_')) {
    return await _handleRoleButton(interaction);
  }

  // ── Operator select button ──────────────────────────────────
  if (id.startsWith('queue_op_')) {
    return await _handleOperatorButton(interaction);
  }

  // ── Report result button (initial + confirm + nevermind) ────
  if (id.startsWith('queue_report_') || id === 'queue_report_nevermind') {
    return await _handleReportButton(interaction);
  }

  // ── Admin resolve (dispute) button ──────────────────────────
  if (id.startsWith('queue_admin_resolve_')) {
    return await _handleAdminResolveButton(interaction);
  }

  // ── Sub / DQ buttons ────────────────────────────────────────
  if (id.startsWith('queue_sub_fresh_') || id.startsWith('queue_sub_mid_')) {
    return await _handleSubButton(interaction);
  }
  if (id.startsWith('queue_dq_')) {
    return await _handleDqButton(interaction);
  }

  // ── Sub player selection buttons ────────────────────────────
  if (id.startsWith('queue_subselect_')) {
    return await _handleSubSelectButton(interaction);
  }

  // ── DQ player selection buttons ─────────────────────────────
  if (id.startsWith('queue_dqselect_')) {
    return await _handleDqSelectButton(interaction);
  }

  // ── Cancel match button (initial + confirm + nevermind) ─────
  if (id.startsWith('queue_cancel_') || id === 'queue_cancel_nevermind') {
    return await _handleCancelButton(interaction);
  }

  // ── Rejoin queue after staff cancel ─────────────────────────
  if (id.startsWith('queue_rejoin_')) {
    return await _handleRejoinButton(interaction);
  }

  console.warn(`[QueueService] Unhandled queue interaction: ${id}`);
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch(() => {});
  }
}

// ── Captain Vote Select Menu handler ──────────────────────────
async function _handleCaptainVoteSelect(interaction) {
  // customId: queue_captain_vote_{matchId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[3], 10);
  const voterId = interaction.user.id;
  const votedForIds = interaction.values; // array of 2 discord IDs

  const result = recordCaptainVote(matchId, voterId, votedForIds);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  await interaction.reply({
    content: `Your vote has been recorded! (${votedForIds.map(id => `<@${id}>`).join(', ')})`,
    ephemeral: true,
    _autoDeleteMs: 10_000,
  });

  // If all voted, finalize immediately
  if (result.allVoted) {
    const match = getMatch(matchId);
    if (match) {
      if (match.timer) { clearTimeout(match.timer); match.timer = null; }
      await finalizeCaptainVote(match);
    }
  }
}

// ── Captain Pick Button handler ───────────────────────────────
async function _handleCaptainPickButton(interaction) {
  // customId: queue_pick_{matchId}_{pickedDiscordId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const pickedPlayerId = parts[3];
  const captainId = interaction.user.id;

  const result = recordCaptainPick(matchId, captainId, pickedPlayerId);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const match = getMatch(matchId);
  if (!match) return;

  // Cancel the pick timer
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }

  const _client = setClient();
  const pickerTeam = match.players.get(captainId)?.team;
  const teamLabel = pickerTeam === 1 ? 'Team 1' : 'Team 2';

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    await textChannel.send({
      content: `<@${captainId}> picked <@${pickedPlayerId}> for **${teamLabel}**`,
    });
  }

  // Defer the button update (the message will be edited by _advancePick)
  await interaction.deferUpdate().catch(() => {});

  await _advancePick(match);
}

// ── Role Button handler ───────────────────────────────────────
async function _handleRoleButton(interaction) {
  // customId: queue_role_{matchId}_{team}_{roleKey}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const teamNum = parseInt(parts[3], 10);
  const roleKey = parts[4];
  const discordId = interaction.user.id;

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Verify player is on this team
  const player = match.players.get(discordId);
  if (!player) return interaction.reply({ content: 'You are not in this match.', ephemeral: true, _autoDeleteMs: 10_000 });
  if (player.team !== teamNum) return interaction.reply({ content: 'This is not your team panel.', ephemeral: true, _autoDeleteMs: 10_000 });

  const result = recordRoleChoice(matchId, discordId, roleKey);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // Refresh the team's role select message
  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    const msg = await _postRoleSelectMessage(match, teamNum, textChannel);
    if (teamNum === 1) match._roleMsg1 = msg;
    else match._roleMsg2 = msg;
  }

  await interaction.deferUpdate().catch(() => {});

  // Check if all players on both teams have completed selections
  _checkAllRolesComplete(match);
}

// ── Operator Button handler ───────────────────────────────────
async function _handleOperatorButton(interaction) {
  // customId: queue_op_{matchId}_{team}_{operatorName_with_underscores}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const teamNum = parseInt(parts[3], 10);
  // Operator name is everything after the 4th underscore, with underscores replaced back to spaces
  const operatorKey = parts.slice(4).join('_');
  const operator = operatorKey.replace(/_/g, ' ');
  const discordId = interaction.user.id;

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  const player = match.players.get(discordId);
  if (!player) return interaction.reply({ content: 'You are not in this match.', ephemeral: true, _autoDeleteMs: 10_000 });
  if (player.team !== teamNum) return interaction.reply({ content: 'This is not your team panel.', ephemeral: true, _autoDeleteMs: 10_000 });

  const result = recordOperatorChoice(matchId, discordId, operator);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // Refresh the team's role select message
  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    const msg = await _postRoleSelectMessage(match, teamNum, textChannel);
    if (teamNum === 1) match._roleMsg1 = msg;
    else match._roleMsg2 = msg;
  }

  await interaction.deferUpdate().catch(() => {});

  _checkAllRolesComplete(match);
}

// ── Report Result Button handler ──────────────────────────────
async function _handleReportButton(interaction) {
  const id = interaction.customId;

  // "Nevermind" button on the confirmation ephemeral
  if (id === 'queue_report_nevermind') {
    return interaction.update({ content: 'Report cancelled.', components: [] });
  }

  // Confirmation step: queue_report_{matchId}_{team} → show confirm
  if (!id.startsWith('queue_report_confirm_')) {
    const parts = id.split('_');
    const matchId = parseInt(parts[2], 10);
    const winningTeam = parseInt(parts[3], 10);
    const match = getMatch(matchId);
    if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

    const captainId = interaction.user.id;
    const isCap = captainId === match.captains?.team1 || captainId === match.captains?.team2;
    if (!isCap) return interaction.reply({ content: 'Only captains can report results.', ephemeral: true });

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_report_confirm_${matchId}_${winningTeam}`)
        .setLabel(`Yes, Team ${winningTeam} Won`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('queue_report_nevermind')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: `Are you sure you want to report **Team ${winningTeam}** as the winner?`,
      components: [confirmRow],
      ephemeral: true,
    });
  }

  // Confirmed: queue_report_confirm_{matchId}_{winningTeam}
  const parts = id.split('_');
  const matchId = parseInt(parts[3], 10);
  const winningTeam = parseInt(parts[4], 10);
  const captainId = interaction.user.id;

  await interaction.update({ content: `Reporting Team ${winningTeam} as the winner...`, components: [] });

  const result = recordVote(matchId, captainId, winningTeam);
  if (!result.success) {
    return interaction.followUp({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const match = getMatch(matchId);
  if (!match) return;

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  if (!result.allVoted) {
    // First captain voted — notify
    if (textChannel) {
      await textChannel.send({
        content: `<@${captainId}> reported **Team ${winningTeam}** as the winner. Waiting for the other captain to confirm...`,
      });
    }
    return interaction.deferUpdate().catch(() => {});
  }

  // Both voted
  if (result.agreed) {
    // Captains agree — resolve
    if (textChannel) {
      await textChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Match Result Confirmed')
            .setColor(0x2ecc71)
            .setDescription(`Both captains agree: **Team ${result.winningTeam}** wins!`)
        ],
      });
    }

    // Disable match message buttons
    if (match._matchMsg) {
      try { await match._matchMsg.edit({ components: [] }); } catch { /* */ }
    }

    await interaction.deferUpdate().catch(() => {});
    await resolveMatch(_client, match, result.winningTeam);
  } else {
    // Dispute — captains disagree
    const staffPings = [
      process.env.ADMIN_ROLE_ID,
      process.env.OWNER_ROLE_ID,
    ].filter(Boolean).map(id => `<@&${id}>`).join(' ');

    const disputeEmbed = new EmbedBuilder()
      .setTitle('Result Disputed')
      .setColor(0xe74c3c)
      .setDescription([
        'Captains disagree on the result.',
        `Captain 1 (<@${match.captains.team1}>) says: **Team ${match.captain1Vote}** won`,
        `Captain 2 (<@${match.captains.team2}>) says: **Team ${match.captain2Vote}** won`,
        '',
        `${staffPings} — Please resolve this dispute.`,
      ].join('\n'));

    const resolveRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_admin_resolve_${match.id}_1`)
        .setLabel('Team 1 Wins (Admin)')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`queue_admin_resolve_${match.id}_2`)
        .setLabel('Team 2 Wins (Admin)')
        .setStyle(ButtonStyle.Danger),
    );

    if (textChannel) {
      await textChannel.send({ embeds: [disputeEmbed], components: [resolveRow] });
    }
    await interaction.deferUpdate().catch(() => {});
  }
}

// ── Admin Resolve (Dispute) Button handler ────────────────────
async function _handleAdminResolveButton(interaction) {
  // customId: queue_admin_resolve_{matchId}_{winningTeam}
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can resolve disputes.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[3], 10);
  const winningTeam = parseInt(parts[4], 10);

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });
  if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') {
    return interaction.reply({ content: 'Match already resolved.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    await textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Dispute Resolved by Staff')
          .setColor(0x2ecc71)
          .setDescription(`<@${interaction.user.id}> resolved the dispute: **Team ${winningTeam}** wins.`),
      ],
    });
  }

  // Disable the dispute resolve buttons
  try { await interaction.update({ components: [] }); } catch { /* */ }

  // Disable match message buttons too
  if (match._matchMsg) {
    try { await match._matchMsg.edit({ components: [] }); } catch { /* */ }
  }

  // Audit the admin action — matches the pattern used for wager-match
  // dispute resolutions (src/interactions/matchResult/adminResolve.js).
  // Without this, rogue staff could resolve queue disputes without a trace.
  const { logAdminAction } = require('../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_queue_dispute', 'match', matchId, {
    winningTeam,
    captain1: match.captains?.team1,
    captain2: match.captains?.team2,
    captain1Vote: match.captain1Vote,
    captain2Vote: match.captain2Vote,
  });

  await resolveMatch(_client, match, winningTeam);
}

// ── Sub Button handler ────────────────────────────────────────
async function _handleSubButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can sub players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_sub_fresh_{matchId} or queue_sub_mid_{matchId}
  const isFresh = interaction.customId.startsWith('queue_sub_fresh_');
  // Use 'fresh' or 'midseries' (no underscore) in customIds to avoid split issues
  const subTypeKey = isFresh ? 'fresh' : 'midseries';
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[parts.length - 1], 10);

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Show buttons for each player in the match to select who to sub out
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount = 0;

  for (const [discordId] of match.players) {
    const user = userRepo.findByDiscordId(discordId);
    const name = user?.display_name || discordId.slice(0, 15);
    const player = match.players.get(discordId);
    const teamLabel = player.team === 1 ? 'T1' : player.team === 2 ? 'T2' : '?';

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_subselect_${matchId}_${subTypeKey}_${discordId}`)
        .setLabel(`[${teamLabel}] ${name}`)
        .setStyle(ButtonStyle.Primary),
    );
    btnCount++;

    if (btnCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  return interaction.reply({
    content: `Select the player to sub out (**${isFresh ? 'Fresh' : 'Mid-Series'}**):`,
    components: rows,
    ephemeral: true,
  });
}

// ── Sub Select Button handler (staff picks who to sub) ────────
async function _handleSubSelectButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can sub players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_subselect_{matchId}_{subTypeKey}_{discordId}
  // subTypeKey is 'fresh' or 'midseries' (no underscore)
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const subTypeKey = parts[3]; // 'fresh' or 'midseries'
  const subType = subTypeKey === 'midseries' ? 'mid_series' : 'fresh';
  const targetDiscordId = parts[4];

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  const player = match.players.get(targetDiscordId);
  if (!player) return interaction.reply({ content: 'Player not in match.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Find replacement from queue — closest XP
  const replacement = findClosestXpReplacement(player.xp);
  if (!replacement) {
    return interaction.update({
      content: 'No replacement available in the queue.',
      components: [],
    });
  }

  const result = subPlayerOut(matchId, targetDiscordId, replacement.discordId, subType);
  if (!result.success) {
    // Re-queue the replacement we just popped
    waitingQueue.push(replacement);
    return interaction.update({ content: `Sub failed: ${result.error}`, components: [] });
  }

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  // Grant channel access to the replacement
  if (textChannel) {
    try {
      await textChannel.permissionOverwrites.create(replacement.discordId, {
        ViewChannel: true, SendMessages: true,
      });
    } catch { /* */ }
  }
  const voiceChannel = _client?.channels?.cache?.get(match.voiceChannelId);
  if (voiceChannel) {
    try {
      await voiceChannel.permissionOverwrites.create(replacement.discordId, {
        ViewChannel: true, Connect: true, Speak: true,
      });
    } catch { /* */ }
  }

  if (textChannel) {
    const subLabel = subType === 'fresh' ? 'Fresh Sub' : 'Mid-Series Sub';
    await textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Player Substitution (${subLabel})`)
          .setColor(0xe67e22)
          .setDescription([
            `<@${targetDiscordId}> has been subbed out.`,
            `<@${replacement.discordId}> has been subbed in (${replacement.xp.toLocaleString()} XP).`,
          ].join('\n')),
      ],
    });
  }

  return interaction.update({ content: `Subbed <@${targetDiscordId}> out for <@${replacement.discordId}>.`, components: [] });
}

// ── DQ Button handler ─────────────────────────────────────────
async function _handleDqButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can DQ players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_dq_{matchId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Show buttons for each player
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount = 0;

  for (const [discordId] of match.players) {
    const user = userRepo.findByDiscordId(discordId);
    const name = user?.display_name || discordId.slice(0, 15);
    const player = match.players.get(discordId);
    const teamLabel = player.team === 1 ? 'T1' : player.team === 2 ? 'T2' : '?';

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_dqselect_${matchId}_${discordId}`)
        .setLabel(`[${teamLabel}] ${name}`)
        .setStyle(ButtonStyle.Danger),
    );
    btnCount++;

    if (btnCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  return interaction.reply({
    content: `Select the player to DQ (**-${QUEUE_CONFIG.DQ_PENALTY} XP penalty**):`,
    components: rows,
    ephemeral: true,
  });
}

// ── DQ Select Button handler ──────────────────────────────────
async function _handleDqSelectButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can DQ players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_dqselect_{matchId}_{discordId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const targetDiscordId = parts[3];

  const match = getMatch(matchId);
  if (!match) return interaction.update({ content: 'Match not found.', components: [] });

  const player = match.players.get(targetDiscordId);
  if (!player) return interaction.update({ content: 'Player not in match.', components: [] });

  // Apply DQ penalty. addXp + xp_history wrapped in one db.transaction
  // so the player's xp_points column and the leaderboard's xp_history
  // view can't diverge (rank roles read xp_points, leaderboard sums
  // xp_history).
  try {
    const user = userRepo.findByDiscordId(targetDiscordId);
    if (user) {
      const dbRef = require('../database/db');
      const { getCurrentSeason } = require('../panels/leaderboardPanel');
      const insertDqXpHistory = dbRef.prepare(
        'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
      );
      const penalizeDqTx = dbRef.transaction((userId) => {
        // addXp floors at 0; use the returned actual delta for xp_history.
        const actualDelta = userRepo.addXp(userId, -QUEUE_CONFIG.DQ_PENALTY);
        if (actualDelta !== 0) {
          // match_id NULL — xp_history.match_id has a FK to matches(id),
          // and queue match ids come from a separate sequence in
          // queue_matches. match_type='queue' identifies these rows.
          insertDqXpHistory.run(userId, null, 'queue', actualDelta, getCurrentSeason());
        }
      });
      penalizeDqTx(user.id);
    }
    // Log to admin feed
    const { postTransaction: ptxDq } = require('../utils/transactionFeed');
    ptxDq({
      type: 'queue_dq',
      discordId: targetDiscordId,
      memo: `Queue Match #${match.id} DQ: <@${targetDiscordId}> — -${QUEUE_CONFIG.DQ_PENALTY} XP by <@${interaction.user.id}>`,
    });
  } catch (err) {
    console.error(`[QueueService] Failed to apply DQ penalty to ${targetDiscordId}:`, err.message);
  }

  // Remove the player from the match and attempt replacement from
  // the waiting queue. Without this, a DQ'd player stays in the
  // match data structure — they'd appear as a pickable player in
  // captain pick and count as a team member in role select, leaving
  // their team effectively down a player (e.g. 4v5).
  const playerTeam = player.team;
  match.players.delete(targetDiscordId);
  if (playerTeam === 1) {
    const idx = match.team1.indexOf(targetDiscordId);
    if (idx !== -1) match.team1.splice(idx, 1);
  } else if (playerTeam === 2) {
    const idx = match.team2.indexOf(targetDiscordId);
    if (idx !== -1) match.team2.splice(idx, 1);
  }

  // If the DQ'd player was a captain, pick the highest-XP remaining
  // teammate as the new captain.
  if (match.captains?.team1 === targetDiscordId) {
    const t1Players = [...match.players.values()].filter(p => p.team === 1).sort((a, b) => b.xp - a.xp);
    match.captains.team1 = t1Players[0]?.discordId || null;
    if (t1Players[0]) t1Players[0].isCaptain = true;
  }
  if (match.captains?.team2 === targetDiscordId) {
    const t2Players = [...match.players.values()].filter(p => p.team === 2).sort((a, b) => b.xp - a.xp);
    match.captains.team2 = t2Players[0]?.discordId || null;
    if (t2Players[0]) t2Players[0].isCaptain = true;
  }

  // Try to find a replacement from the waiting queue
  let replacementMsg = '';
  const replacement = findClosestXpReplacement(player.xp);
  if (replacement) {
    const { _newPlayer } = require('./state');
    const repPlayer = _newPlayer(replacement.discordId, replacement.xp);
    repPlayer.team = playerTeam; // put on same team (or unassigned if no team yet)
    match.players.set(replacement.discordId, repPlayer);
    if (playerTeam === 1) match.team1.push(replacement.discordId);
    else if (playerTeam === 2) match.team2.push(replacement.discordId);
    replacementMsg = `\nReplaced by <@${replacement.discordId}> (${replacement.xp} XP) from the queue.`;
  } else {
    replacementMsg = '\nNo replacement available in the queue.';
    // If we're in early phases and down to <10 players with no replacement, cancel
    if (match.players.size < QUEUE_CONFIG.TOTAL_PLAYERS && ['WAITING_VOICE', 'CAPTAIN_VOTE', 'CAPTAIN_PICK'].includes(match.phase)) {
      const { cancelMatch } = require('./matchLifecycle');
      await cancelMatch(interaction.client, match, `DQ left match with fewer than ${QUEUE_CONFIG.TOTAL_PLAYERS} players and no replacement available`);
      replacementMsg += ' **Match cancelled due to insufficient players.**';
    }
  }

  const _client = setClient();
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    await textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Player Disqualified')
          .setColor(0xe74c3c)
          .setDescription([
            `<@${targetDiscordId}> has been **disqualified** by <@${interaction.user.id}>.`,
            `Penalty: **-${QUEUE_CONFIG.DQ_PENALTY} XP**`,
            replacementMsg,
          ].join('\n')),
      ],
    });
  }

  return interaction.update({
    content: `DQ'd <@${targetDiscordId}> with -${QUEUE_CONFIG.DQ_PENALTY} XP penalty.${replacementMsg}`,
    components: [],
  });
}

// ── Cancel Match (staff only, with confirmation) ────────────
async function _handleCancelButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can cancel queue matches.', ephemeral: true });
  }

  const id = interaction.customId;

  // "Nevermind" button on the confirmation
  if (id === 'queue_cancel_nevermind') {
    return interaction.update({ content: 'Cancel aborted.', components: [] });
  }

  // Confirmation step: queue_cancel_{matchId} → show confirm
  if (!id.startsWith('queue_cancel_confirm_')) {
    const matchId = parseInt(id.replace('queue_cancel_', ''), 10);
    const match = getMatch(matchId);
    if (!match) return interaction.reply({ content: 'Match not found or already ended.', ephemeral: true });
    if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') {
      return interaction.reply({ content: 'This match has already ended.', ephemeral: true });
    }

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_cancel_confirm_${matchId}`)
        .setLabel('Yes, Cancel This Match')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('queue_cancel_nevermind')
        .setLabel('No, Go Back')
        .setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: `⚠️ Are you sure you want to cancel **Queue Match #${matchId}**? No XP changes will be applied.`,
      components: [confirmRow],
      ephemeral: true,
    });
  }

  // Confirmed: queue_cancel_confirm_{matchId}
  const matchId = parseInt(id.replace('queue_cancel_confirm_', ''), 10);
  const match = getMatch(matchId);
  if (!match) return interaction.update({ content: 'Match already ended.', components: [] });
  if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') {
    return interaction.update({ content: 'This match has already ended.', components: [] });
  }

  await interaction.update({ content: 'Cancelling match...', components: [] });

  const { cancelMatch, _postCancelWithRejoinWindow } = require('./matchLifecycle');
  // skipCleanupSchedule — _postCancelWithRejoinWindow manages its own
  // 15s cleanup window, so the default 60s cancelMatch cleanup must
  // not also fire.
  await cancelMatch(
    interaction.client,
    match,
    `Cancelled by staff (<@${interaction.user.id}>)`,
    { skipCleanupSchedule: true },
  );

  // Disable the Report / Sub / DQ / Cancel buttons on the match embed
  // so players can't trigger new actions on a cancelled match. Specific
  // to staff-cancel — auto-cancel (no-show) fires before the match
  // message exists.
  if (match._matchMsg) {
    try { await match._matchMsg.edit({ components: [] }); } catch { /* */ }
  }

  await _postCancelWithRejoinWindow(interaction.client, match, {
    headerLines: [
      `This match has been cancelled by <@${interaction.user.id}>.`,
      `**No XP changes.**`,
    ],
    eligibleDiscordIds: [...match.players.keys()],
  });
}

// ── Rejoin Queue button (shown after staff cancel, 15s window) ─
async function _handleRejoinButton(interaction) {
  const discordId = interaction.user.id;

  // A stale (>3s) or already-acked interaction would throw on reply.
  // Log and swallow so we never abort the queue-side side effects just
  // because the user's ack failed.
  const safeReply = (payload) =>
    interaction.reply(payload).catch(err => {
      console.error('[QueueService] Rejoin: interaction.reply failed:', err.message);
    });

  const user = userRepo.findByDiscordId(discordId);
  if (!user || !user.accepted_tos) {
    return safeReply({
      content: 'You need to register first. Head to the welcome channel and accept the Terms of Service.',
      ephemeral: true,
      _autoDeleteMs: 15_000,
    });
  }

  const queueService = require('./index');

  if (queueService.isInQueue(discordId)) {
    return safeReply({
      content: 'You are already in the queue.',
      ephemeral: true,
      _autoDeleteMs: 10_000,
    });
  }

  const activeMatchId = queueService.isInActiveMatch(discordId);
  if (activeMatchId) {
    return safeReply({
      content: `You are already in an active queue match (#${activeMatchId}).`,
      ephemeral: true,
      _autoDeleteMs: 10_000,
    });
  }

  const { isPlayerBusy } = require('../utils/playerStatus');
  const busy = isPlayerBusy(user.id, discordId);
  if (busy.busy) {
    return safeReply({
      content: busy.reason,
      ephemeral: true,
      _autoDeleteMs: 10_000,
    });
  }

  const xp = user.xp_points || 0;
  const newSize = queueService.joinQueue(discordId, xp);

  await safeReply({
    content: `Re-joined queue. (${newSize}/${QUEUE_CONFIG.TOTAL_PLAYERS})`,
    ephemeral: true,
    _autoDeleteMs: 10_000,
  });

  // Auto-create match if this rejoin fills the queue. The second size
  // check guards against a TOCTOU race: two near-simultaneous rejoins
  // can both observe newSize >= TOTAL_PLAYERS after their respective
  // joins (queue of 9 → two clicks yield sizes 10 and 11). Without the
  // re-check, both would call createMatch and the second would splice
  // a short roster off an empty queue.
  if (newSize >= QUEUE_CONFIG.TOTAL_PLAYERS && queueService.getQueueSize() >= QUEUE_CONFIG.TOTAL_PLAYERS) {
    try {
      const guild = interaction.guild || interaction.client.guilds.cache.get(process.env.GUILD_ID);
      if (guild) {
        const { createMatch } = require('./matchLifecycle');
        await createMatch(interaction.client, guild);
      }
    } catch (err) {
      console.error('[QueueService] Rejoin: auto-create match failed:', err.message);
    }
  }

  // Single panel refresh at the end. Uses the lightweight helper
  // (fetch limit 10, one edit) so even 10 simultaneous clicks stay
  // well under Discord's per-channel edit rate limits.
  try {
    const { refreshQueuePanel } = require('../panels/queuePanel');
    await refreshQueuePanel(interaction.client);
  } catch (err) {
    console.error('[QueueService] Rejoin: panel refresh failed:', err.message);
  }
}

module.exports = {
  handleQueueInteraction,
};

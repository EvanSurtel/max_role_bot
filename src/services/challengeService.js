// Challenge lifecycle — teammate notification, board posting, cancellation.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../base/escrowManager');
const channelService = require('./channelService');
const timerService = require('./timerService');
const { challengeEmbed, formatUsdc } = require('../utils/embeds');
const { CHALLENGE_STATUS, PLAYER_STATUS, TIMERS, GAME_MODES, CHALLENGE_TYPE } = require('../config/constants');
const { t, getLang } = require('../locales/i18n');

// Teammate-accept timers are persisted via timerService (DB-backed) so
// a bot restart during the 10-min decline window doesn't strand the
// challenge in PENDING_TEAMMATES with held funds. The handler is
// registered in src/services/timerHandlers.js for type 'teammate_accept'
// with referenceId = challenge_players.id; on fire it atomically flips
// PENDING → DECLINED and cancels the challenge (refund all holds).

/**
 * Notify each pending teammate about a challenge invitation.
 *
 * Strategy: try DM first (so we don't burn through Discord's 500
 * channels-per-guild limit on transient invite channels). If the
 * teammate has DMs disabled or the send fails for any reason, fall
 * back to creating a private `invite-{username}` channel they can
 * see.
 *
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {object} challenge - The challenge DB record.
 */
async function notifyTeammates(guild, challenge) {
  const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 1);
  const pendingPlayers = players.filter(p => p.status === PLAYER_STATUS.PENDING);

  for (const player of pendingPlayers) {
    try {
      const user = userRepo.findById(player.user_id);
      if (!user) {
        console.error(`[ChallengeService] No user found for player ${player.user_id}`);
        continue;
      }

      const discordId = user.discord_id;

      // Build challenge details embed in the CREATOR's language.
      // If a creator makes a challenge in Spanish, their teammates are
      // likely Spanish-speaking too, so use the creator's preference.
      const creatorUser = userRepo.findById(challenge.creator_user_id);
      const lang = creatorUser ? getLang(creatorUser.discord_id) : getLang(discordId);
      const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
      const modeInfo = GAME_MODES[challenge.game_modes];
      const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;

      const creatorMention = creatorUser ? `<@${creatorUser.discord_id}>` : 'Unknown';
      const typeLabel = isCashMatch ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
      const displayNum = challenge.display_number || challenge.id;

      const description = [
        t('notify_team.description', lang, { creator: creatorMention }),
        '',
        `**${t('notify_team.field_type', lang)}:** ${typeLabel}`,
        `**${t('notify_team.field_team_size', lang)}:** ${challenge.team_size}v${challenge.team_size}`,
        `**${t('notify_team.field_mode', lang)}:** ${modeLabel}`,
        `**${t('notify_team.field_series', lang)}:** ${t('challenge_create.series_label', lang, { n: challenge.series_length })}`,
      ];

      if (isCashMatch) {
        const entryAmount = (Number(challenge.entry_amount_usdc) / 1_000_000).toFixed(2);
        description.push(`**${t('notify_team.field_entry', lang)}:** ${t('notify_team.entry_per_player', lang, { amount: entryAmount })}`);
      }

      description.push('', t('notify_team.accept_window', lang, { minutes: TIMERS.TEAMMATE_ACCEPT / 60000 }));

      // Build buttons in the recipient's language
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`teammate_accept_${challenge.id}`)
          .setLabel(t('notify_team.btn_accept', lang))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`teammate_decline_${challenge.id}`)
          .setLabel(t('notify_team.btn_decline', lang))
          .setStyle(ButtonStyle.Danger),
      );

      const embedPayload = {
        title: t('notify_team.title', lang, { type: typeLabel, num: displayNum }),
        description: description.join('\n'),
        color: isCashMatch ? 0xf1c40f : 0x3498db,
      };

      // ── DM only — no private-channel fallback ────────────────────
      // Policy: teammate invites are DM-only. If the teammate has DMs
      // disabled for this server, they auto-decline — the creator
      // gets told, and the challenge is cancelled (or has to be
      // retried with a different teammate, or dropped to 1v1).
      //
      // Rationale: private invite channels balloon the server's
      // channel count (Discord cap 500/guild) and clutter the
      // category list. Users are expected to have DMs enabled for
      // the bot; we announce this at onboarding / in the rules panel.
      let dmUser = null;
      try {
        dmUser = await guild.client.users.fetch(discordId);
        await dmUser.send({ embeds: [embedPayload], components: [row] });
        console.log(`[ChallengeService] DM'd teammate ${discordId} for challenge ${challenge.id}`);
      } catch (dmErr) {
        console.log(`[ChallengeService] DM failed for ${discordId} (${dmErr.message}) — auto-declining teammate`);

        // Auto-decline this teammate. No channel fallback.
        challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.DECLINED);

        // Tell the creator in the admin feed + DM (best effort). The
        // feed post is durable and visible to staff; the DM is a
        // convenience for the creator.
        try {
          const { postTransaction } = require('../utils/transactionFeed');
          const targetMember = await guild.members.fetch(discordId).catch(() => null);
          const targetName = targetMember?.user?.username || discordId;
          const creatorUser = userRepo.findById(challenge.creator_user_id);
          postTransaction({
            type: 'challenge_cancelled',
            challengeId: challenge.id,
            discordId: creatorUser?.discord_id,
            memo: `Teammate @${targetName} (${discordId}) has DMs disabled for this server and can't be invited. Challenge #${challenge.display_number || challenge.id} auto-cancelled. They need to enable "Allow direct messages from server members" in Discord to play anything but 1v1.`,
          });
          if (creatorUser) {
            try {
              const creatorDiscord = await guild.client.users.fetch(creatorUser.discord_id);
              await creatorDiscord.send({
                content: [
                  `Your challenge was cancelled — teammate **${targetName}** has direct messages disabled.`,
                  '',
                  `Ask them to enable **User Settings → Privacy & Safety → Allow direct messages from server members** for this server. They need DMs on to receive team invites.`,
                  '',
                  'If they can\'t enable DMs, you can still create **1v1** challenges with them (those don\'t require teammate invites).',
                ].join('\n'),
              });
            } catch { /* creator may also have DMs off */ }
          }
        } catch { /* best effort — never block cancel on notify */ }

        // Cancel the whole challenge (refund, clean up any other
        // teammates that already accepted). Pass client so cancel
        // can also delete any leftover channels from older flows.
        await cancelChallenge(challenge.id, guild.client);
        return;
      }

      // DB-backed timeout timer (registered handler in timerHandlers.js
      // does the atomic PENDING → DECLINED + cancelChallenge work).
      // Replaces a bare setTimeout that was lost on bot restart, which
      // could leave a challenge stuck in PENDING_TEAMMATES with the
      // captain's USDC held forever.
      timerService.createTimer('teammate_accept', player.id, TIMERS.TEAMMATE_ACCEPT);
    } catch (err) {
      console.error(`[ChallengeService] Error notifying teammate ${player.user_id}:`, err);
    }
  }
}

/**
 * Post the challenge to the public challenge board channel.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function postToBoard(client, challenge) {
  // Route cash match challenges to CHALLENGES_CHANNEL_ID, XP challenges to XP_CHALLENGES_CHANNEL_ID
  const channelId = challenge.type === 'xp'
    ? (process.env.XP_CHALLENGES_CHANNEL_ID || process.env.CHALLENGES_CHANNEL_ID)
    : process.env.CHALLENGES_CHANNEL_ID;
  if (!channelId) {
    console.error('[ChallengeService] Challenge channel ID not set');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(`[ChallengeService] Challenge board channel ${channelId} not found in cache`);
    return;
  }

  // The board is shared, so the embed itself is in the bot display
  // language. Each user can click 🌐 to see this specific challenge
  // re-rendered in their own language as a personal ephemeral.
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const displayLang = getBotDisplayLanguage();

  // Build the embed — include team player names if not anonymous
  let teamPlayers = null;
  if (!challenge.is_anonymous) {
    const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 1);
    teamPlayers = players.map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? { discord_id: u.discord_id, cod_ign: u.cod_ign, server_username: u.server_username } : null;
    }).filter(Boolean);
  }
  const embed = challengeEmbed(challenge, !!challenge.is_anonymous, teamPlayers, displayLang);

  // Build the accept + cancel buttons + inline language dropdown
  const { buildChallengeLanguageDropdown } = require('../interactions/perMessageLanguage');
  const { t } = require('../locales/i18n');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge_accept_${challenge.id}`)
      .setLabel(t('challenge_create.btn_accept_challenge', displayLang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`challenge_cancel_${challenge.id}`)
      .setLabel(t('challenge_create.btn_cancel_challenge', displayLang))
      .setStyle(ButtonStyle.Danger),
    // Creator-only "Extend +10 min" button. Click validates the actor
    // is the creator, then bumps challenges.expires_at by +10 min and
    // re-creates the timerService row. Matches CMG's "extend by 10
    // minutes if not accepted" feature so a creator who's still
    // looking for an opponent can keep their challenge alive without
    // re-creating it from scratch (and re-locking funds).
    new ButtonBuilder()
      .setCustomId(`challenge_extend_${challenge.id}`)
      .setLabel('Extend +10 min')
      .setStyle(ButtonStyle.Secondary),
  );
  const langRow = buildChallengeLanguageDropdown(challenge.id, displayLang);

  const message = await channel.send({
    embeds: [embed],
    components: [row, langRow],
  });

  // Store message reference on the challenge
  challengeRepo.setMessageId(challenge.id, message.id, channel.id);

  // Ensure challenge status is 'open'
  if (challenge.status !== CHALLENGE_STATUS.OPEN) {
    challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.OPEN);
  }

  // Create a challenge_expiry timer so the challenge auto-expires
  if (challenge.expires_at) {
    const remainingMs = new Date(challenge.expires_at).getTime() - Date.now();
    if (remainingMs > 0) {
      timerService.createTimer('challenge_expiry', challenge.id, remainingMs);
      console.log(`[ChallengeService] Created expiry timer for challenge #${challenge.id} (${remainingMs}ms)`);
    } else {
      // Already expired — fire immediately
      timerService.createTimer('challenge_expiry', challenge.id, 0);
      console.log(`[ChallengeService] ${challenge.type === 'cash_match' ? 'Cash Match' : 'XP Match'} #${challenge.display_number || challenge.id} already past expiry, firing immediately`);
    }
  }

  console.log(`[ChallengeService] Posted challenge #${challenge.id} to board (msg ${message.id})`);
}

/**
 * Cancel a challenge — refund all held funds, update status, delete
 * private invite channels that were created as a fallback for
 * teammates with DMs disabled.
 *
 * @param {number} challengeId - The challenge ID.
 * @param {import('discord.js').Client} [client] - Optional Discord
 *   client. When provided, orphaned private invite channels stored
 *   in `challenge_players.notification_channel_id` are fetched and
 *   deleted. Callers running from timer handlers / non-interaction
 *   contexts may not have one — in that case the channels are left
 *   in place (logged as a warning) rather than skipping the rest of
 *   the cancel.
 */
async function cancelChallenge(challengeId, client = null) {
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    console.error(`[ChallengeService] Challenge ${challengeId} not found for cancellation`);
    return;
  }

  // Atomic status transition: only cancel from a pre-match state.
  // This prevents a race where cancelChallenge (from a teammate
  // timeout timer) runs at the same time as startMatch (from the
  // last teammate accepting). Without this, the cancel could refund
  // DB holds while startMatch is pulling the same funds into escrow.
  const CANCELLABLE = [
    CHALLENGE_STATUS.PENDING_TEAMMATES,
    CHALLENGE_STATUS.OPEN,
    CHALLENGE_STATUS.ACCEPTED,
  ];
  if (!CANCELLABLE.includes(challenge.status)) {
    console.log(`[ChallengeService] Challenge #${challengeId} is ${challenge.status} — not cancellable, skipping`);
    return;
  }
  const claimed = challengeRepo.atomicStatusTransition(challengeId, challenge.status, CHALLENGE_STATUS.CANCELLED);
  if (!claimed) {
    console.log(`[ChallengeService] Challenge #${challengeId} status changed before cancel could claim it — skipping`);
    return;
  }

  // Refund all held funds
  escrowManager.refundAll(challengeId);

  // Cancel any pending expiry timer for this challenge
  timerService.cancelTimersByReference('challenge_expiry', challengeId);

  // Clear any teammate-accept timers for every player in this
  // challenge. Timers are keyed by challenge_player.id; iterate the
  // roster to cancel each one (timerService doesn't support
  // cancelling by a parent challengeId because the timer reference
  // is the player row, not the challenge row).
  const allPlayersForTimerCleanup = challengePlayerRepo.findByChallengeId(challengeId);
  for (const p of allPlayersForTimerCleanup) {
    timerService.cancelTimersByReference('teammate_accept', p.id);
  }

  // Delete any private invite channels that were created as a DM
  // fallback. These only exist when a teammate had DMs disabled and
  // we had to route the invite through a private server channel
  // (see notifyTeammates). DMs themselves can't be deleted by bots
  // (Discord API limit), but the stale embed in a DM auto-fades as
  // the user sees the cancel result elsewhere.
  const players = challengePlayerRepo.findByChallengeId(challengeId);
  const channelIds = players
    .map(p => p.notification_channel_id)
    .filter(Boolean);

  if (channelIds.length > 0) {
    if (client) {
      for (const channelId of channelIds) {
        try {
          const channel = client.channels.cache.get(channelId)
            || await client.channels.fetch(channelId).catch(() => null);
          if (channel) {
            await channelService.deleteChannel(channel);
          }
        } catch (err) {
          console.warn(`[ChallengeService] Failed to delete invite channel ${channelId} for cancelled #${challengeId}: ${err.message}`);
        }
      }
    } else {
      console.warn(`[ChallengeService] cancelChallenge(${challengeId}) called without client — ${channelIds.length} invite channel(s) not deleted: ${channelIds.join(', ')}`);
    }
  }

  console.log(`[ChallengeService] Challenge #${challengeId} cancelled${channelIds.length > 0 ? ` (cleaned ${channelIds.length} invite channels)` : ''}`);
}

/**
 * Called when the last teammate accepts — updates status and posts to board.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function handleAllTeammatesAccepted(client, challenge) {
  // Atomic claim — two teammate accepts landing in the same tick can
  // both see pendingCount === 0 (there's an `await interaction.reply`
  // between the status write and the count read in teammateResponse),
  // and both call this function. Without the claim below, postToBoard
  // runs twice and the challenge appears on the board as a duplicate.
  // atomicStatusTransition uses BEGIN IMMEDIATE so only the first
  // caller wins PENDING_TEAMMATES -> OPEN.
  const claimed = challengeRepo.atomicStatusTransition(
    challenge.id,
    CHALLENGE_STATUS.PENDING_TEAMMATES,
    CHALLENGE_STATUS.OPEN,
  );
  if (!claimed) {
    console.log(`[ChallengeService] handleAllTeammatesAccepted race lost for #${challenge.id} \u2014 another caller already posted to the board`);
    return;
  }

  // Refresh the challenge record so postToBoard sees the updated status
  const updatedChallenge = challengeRepo.findById(challenge.id);

  // Post to the challenge board
  await postToBoard(client, updatedChallenge || challenge);

  console.log(`[ChallengeService] All teammates accepted for challenge #${challenge.id}, posted to board`);
}

/**
 * Clear a teammate timer (used when a teammate responds before timeout).
 *
 * @param {number} challengeId - The challenge ID (kept for API compat;
 *   timer reference is the challenge_player.id, but callers commonly
 *   pass both).
 * @param {number} playerId - The challenge_player ID.
 */
function clearTeammateTimer(challengeId, playerId) {
  timerService.cancelTimersByReference('teammate_accept', playerId);
}

module.exports = {
  notifyTeammates,
  postToBoard,
  cancelChallenge,
  handleAllTeammatesAccepted,
  clearTeammateTimer,
};

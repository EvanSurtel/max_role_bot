// Mid-match cancel request flow.
//
// Once a match is IN_PROGRESS, the creator cannot unilaterally cancel
// (funds are locked in the escrow contract). This flow lets either
// captain REQUEST a cancel; the opposing captain must explicitly
// approve before anything moves. Both the request and the approval
// go through confirm buttons so no one-click cancels a live match.
//
// customIds used:
//   match_cancel_request_<matchId>                       captain clicks "Request Cancel"
//   match_cancel_req_confirm_<matchId>                   requesting captain confirms
//   match_cancel_accept_<matchId>_<reqUid>               opposing captain accepts
//   match_cancel_acc_confirm_<matchId>_<reqUid>          opposing captain confirms accept
//   match_cancel_reject_<matchId>                        opposing captain rejects
//
// DB-wise: we reuse MATCH_STATUS.CANCELLED and the existing
// challengeRepo.atomicStatusTransition + escrowManager.cancelOnChainMatch
// path. The request-state itself is in-memory only (one pending request
// per match at a time); a bot restart drops the pending request, which
// is the same behavior as other ephemeral match-channel interactions.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../base/escrowManager');
const {
  MATCH_STATUS,
  CHALLENGE_STATUS,
  CHALLENGE_TYPE,
  PLAYER_ROLE,
} = require('../config/constants');

// In-memory map of in-flight cancel requests.
// key = matchId, value = { requesterUserId, requesterTeam, requestedAt, messageId }
const pendingRequests = new Map();
const REQUEST_TTL_MS = 30 * 60 * 1000; // auto-expire after 30 min

function _getCaptainForUser(match, user) {
  const players = challengePlayerRepo.findByChallengeId(match.challenge_id);
  const self = players.find(p => p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN);
  return self ? { team: self.team } : null;
}

function _getOpposingCaptainDiscordId(match, myTeam) {
  const players = challengePlayerRepo.findByChallengeId(match.challenge_id);
  const opposingTeam = myTeam === 1 ? 2 : 1;
  const opposing = players.find(p => p.team === opposingTeam && p.role === PLAYER_ROLE.CAPTAIN);
  if (!opposing) return null;
  const u = userRepo.findById(opposing.user_id);
  return u ? u.discord_id : null;
}

function _expirePending(matchId) {
  const entry = pendingRequests.get(matchId);
  if (!entry) return;
  if (Date.now() - entry.requestedAt > REQUEST_TTL_MS) {
    pendingRequests.delete(matchId);
  }
}

// Step 1 — captain clicks "Request Cancel" in the vote channel.
async function handleRequestButton(interaction) {
  const matchId = parseInt(interaction.customId.replace('match_cancel_request_', ''), 10);
  if (isNaN(matchId)) {
    return interaction.reply({ content: 'Invalid match reference.', ephemeral: true });
  }

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.ACTIVE) {
    return interaction.reply({
      content: 'This match is no longer active — cancel requests are only valid during an in-progress match.',
      ephemeral: true,
    });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'You are not registered.', ephemeral: true });

  const cap = _getCaptainForUser(match, user);
  if (!cap) {
    return interaction.reply({ content: 'Only captains can request a match cancel.', ephemeral: true });
  }

  _expirePending(matchId);
  const existing = pendingRequests.get(matchId);
  if (existing) {
    const requester = userRepo.findById(existing.requesterUserId);
    const requesterMention = requester ? `<@${requester.discord_id}>` : `team ${existing.requesterTeam}`;
    return interaction.reply({
      content: `A cancel request from ${requesterMention} is already pending. Wait for the opposing captain to respond (or for it to expire).`,
      ephemeral: true,
    });
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  const isCashMatch = challenge && challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0;
  const entryAmount = isCashMatch
    ? (Number(challenge.entry_amount_usdc) / 1_000_000).toFixed(2)
    : '0';

  const desc = [
    `You are about to **request cancellation** of match #${matchId}.`,
    '',
    isCashMatch
      ? `If the opposing captain approves, the match ends and each player's **$${entryAmount} USDC** entry is refunded on-chain.`
      : 'If the opposing captain approves, the match ends with no XP awarded or lost.',
    '',
    '_The opposing captain can accept or reject. Nothing happens without their approval._',
  ].join('\n');

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Confirm Cancel Request')
    .setColor(0xe67e22)
    .setDescription(desc);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`match_cancel_req_confirm_${matchId}`)
      .setLabel('Yes, request cancel')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('match_cancel_nevermind')
      .setLabel('Nevermind')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true });
}

// Step 2 — requesting captain confirms.
async function handleRequestConfirm(interaction) {
  const matchId = parseInt(interaction.customId.replace('match_cancel_req_confirm_', ''), 10);
  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.ACTIVE) {
    return interaction.update({
      content: 'This match is no longer active.',
      embeds: [], components: [],
    });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.update({ content: 'Not registered.', embeds: [], components: [] });

  const cap = _getCaptainForUser(match, user);
  if (!cap) {
    return interaction.update({
      content: 'Only captains can request a match cancel.',
      embeds: [], components: [],
    });
  }

  _expirePending(matchId);
  if (pendingRequests.has(matchId)) {
    return interaction.update({
      content: 'A cancel request is already pending for this match.',
      embeds: [], components: [],
    });
  }

  const opposingCaptainDiscordId = _getOpposingCaptainDiscordId(match, cap.team);

  const sharedChannel = match.shared_text_id ? interaction.client.channels.cache.get(match.shared_text_id) : null;
  if (!sharedChannel) {
    return interaction.update({
      content: 'Could not find the match shared channel to post the request. Aborted.',
      embeds: [], components: [],
    });
  }

  const requestEmbed = new EmbedBuilder()
    .setTitle(`Cancel Request — Match #${matchId}`)
    .setColor(0xe67e22)
    .setDescription([
      `**<@${user.discord_id}>** (Team ${cap.team} captain) requests to cancel this match.`,
      '',
      'The opposing captain must approve. If approved, the match ends and all entry fees are refunded on-chain.',
      '',
      `_Pinging: ${opposingCaptainDiscordId ? `<@${opposingCaptainDiscordId}>` : `team ${cap.team === 1 ? 2 : 1} captain`}_`,
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`match_cancel_accept_${matchId}_${user.id}`)
      .setLabel('Accept Cancel')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`match_cancel_reject_${matchId}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await sharedChannel.send({
    content: opposingCaptainDiscordId ? `<@${opposingCaptainDiscordId}>` : undefined,
    embeds: [requestEmbed],
    components: [row],
  });

  pendingRequests.set(matchId, {
    requesterUserId: user.id,
    requesterTeam: cap.team,
    requestedAt: Date.now(),
    messageId: sent.id,
    channelId: sharedChannel.id,
  });

  return interaction.update({
    content: `Cancel request posted in the match channel. Waiting for the opposing captain to respond.`,
    embeds: [], components: [],
  });
}

// Step 3 — opposing captain clicks Accept.
async function handleAcceptButton(interaction) {
  const rest = interaction.customId.replace('match_cancel_accept_', '');
  const [matchIdStr, reqUidStr] = rest.split('_');
  const matchId = parseInt(matchIdStr, 10);
  const reqUserId = parseInt(reqUidStr, 10);

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.ACTIVE) {
    return interaction.reply({ content: 'This match is no longer active.', ephemeral: true });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'Not registered.', ephemeral: true });

  _expirePending(matchId);
  const pending = pendingRequests.get(matchId);
  if (!pending || pending.requesterUserId !== reqUserId) {
    return interaction.reply({
      content: 'This cancel request has expired or was replaced.',
      ephemeral: true,
    });
  }

  // Caller must be the OPPOSING captain to the requester.
  const cap = _getCaptainForUser(match, user);
  if (!cap) {
    return interaction.reply({ content: 'Only the opposing captain can respond.', ephemeral: true });
  }
  if (cap.team === pending.requesterTeam) {
    return interaction.reply({
      content: 'Only the opposing captain can accept a cancel request from your team.',
      ephemeral: true,
    });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Confirm Accept Cancel')
    .setColor(0xe74c3c)
    .setDescription([
      `You are about to accept the cancel request for match #${matchId}.`,
      '',
      '**This cannot be undone.** The match ends, channels are cleaned up, and entry fees are refunded on-chain.',
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`match_cancel_acc_confirm_${matchId}_${reqUserId}`)
      .setLabel('Yes, accept and cancel match')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('match_cancel_nevermind')
      .setLabel('Nevermind')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true });
}

// Step 4 — opposing captain confirms accept. Executes the cancel.
async function handleAcceptConfirm(interaction) {
  const rest = interaction.customId.replace('match_cancel_acc_confirm_', '');
  const [matchIdStr, reqUidStr] = rest.split('_');
  const matchId = parseInt(matchIdStr, 10);
  const reqUserId = parseInt(reqUidStr, 10);

  const match = matchRepo.findById(matchId);
  if (!match) {
    return interaction.update({ content: 'Match not found.', embeds: [], components: [] });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.update({ content: 'Not registered.', embeds: [], components: [] });

  _expirePending(matchId);
  const pending = pendingRequests.get(matchId);
  if (!pending || pending.requesterUserId !== reqUserId) {
    return interaction.update({
      content: 'This cancel request has expired or was replaced.',
      embeds: [], components: [],
    });
  }

  const cap = _getCaptainForUser(match, user);
  if (!cap || cap.team === pending.requesterTeam) {
    return interaction.update({
      content: 'Only the opposing captain can confirm acceptance.',
      embeds: [], components: [],
    });
  }

  // Atomic claim — if anyone else (admin resolve, dispute resolution)
  // moved the match status between the Accept click and this
  // Confirm click, do NOT proceed. atomicStatusTransition in matchRepo
  // returns false if the row isn't in the expected status.
  const claimed = matchRepo.atomicStatusTransition(
    matchId,
    [MATCH_STATUS.ACTIVE, MATCH_STATUS.VOTING],
    MATCH_STATUS.CANCELLED,
  );
  if (!claimed) {
    pendingRequests.delete(matchId);
    return interaction.update({
      content: 'This match has already been resolved or moved to a different state. No refund issued.',
      embeds: [], components: [],
    });
  }

  await interaction.update({
    content: 'Processing cancel — this may take a moment for the on-chain refund.',
    embeds: [], components: [],
  });

  const challenge = challengeRepo.findById(match.challenge_id);
  const isCashMatch = challenge && challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0;

  let onChainResult = null;
  if (isCashMatch) {
    try {
      const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
      await escrowManager.cancelOnChainMatch(
        matchId,
        match.challenge_id,
        allPlayers,
        challenge.entry_amount_usdc,
      );
      onChainResult = 'refunded';
    } catch (err) {
      console.error(`[MatchCancelRequest] on-chain cancel failed for match #${matchId}:`, err.message);
      onChainResult = `failed: ${err.message}`;
      // Don't revert the DB claim — the match is still logically
      // cancelled from the game's perspective. Admins can use the
      // emergency-cancel-match script if funds are stuck on-chain.
      // Post a big alert so nobody misses it.
      try {
        const { postTransaction } = require('../utils/transactionFeed');
        postTransaction({
          type: 'balance_mismatch',
          challengeId: match.challenge_id,
          memo: `\u{1F6A8} Mid-match cancel approved but on-chain cancelMatch FAILED for match #${matchId}. Admin: run scripts/emergency-cancel-match.js ${matchId}. Error: ${err.message}`,
        });
      } catch { /* best effort */ }
    }
  }

  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.CANCELLED);

  pendingRequests.delete(matchId);

  // Audit + transaction feed
  try {
    const { postTransaction } = require('../utils/transactionFeed');
    const requesterUser = userRepo.findById(pending.requesterUserId);
    postTransaction({
      type: 'match_cancelled_by_captains',
      challengeId: match.challenge_id,
      memo: `Match #${matchId} cancelled by mutual captain consent. Requester: <@${requesterUser?.discord_id}> (Team ${pending.requesterTeam}). Approver: <@${user.discord_id}>. On-chain: ${isCashMatch ? onChainResult : 'n/a (XP match)'}.`,
    });
  } catch { /* best effort */ }

  // Post result in shared channel
  try {
    if (pending.channelId) {
      const ch = interaction.client.channels.cache.get(pending.channelId);
      if (ch) {
        const requesterUser = userRepo.findById(pending.requesterUserId);
        const approvedEmbed = new EmbedBuilder()
          .setTitle(`Match #${matchId} Cancelled`)
          .setColor(0x95a5a6)
          .setDescription([
            `Cancelled by mutual captain consent.`,
            '',
            `**Requested by:** <@${requesterUser?.discord_id || 'unknown'}> (Team ${pending.requesterTeam})`,
            `**Approved by:** <@${user.discord_id}> (Team ${cap.team})`,
            '',
            isCashMatch
              ? (onChainResult === 'refunded'
                ? 'All entry fees have been refunded on-chain.'
                : '⚠️ On-chain refund failed — staff has been notified.')
              : 'No XP awarded or lost.',
          ].join('\n'));
        await ch.send({ embeds: [approvedEmbed] });
      }
    }
  } catch (err) {
    console.warn(`[MatchCancelRequest] Failed to post result in shared channel:`, err.message);
  }

  // Schedule match channel cleanup like resolveMatch does.
  setTimeout(async () => {
    try {
      const { cleanupChannels } = require('../services/match/cleanup');
      await cleanupChannels(interaction.client, matchId);
    } catch (err) {
      console.error(`[MatchCancelRequest] cleanup failed for #${matchId}:`, err.message);
    }
  }, 5 * 60 * 1000);
}

// Step 3b — opposing captain clicks Reject.
async function handleRejectButton(interaction) {
  const matchId = parseInt(interaction.customId.replace('match_cancel_reject_', ''), 10);

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: 'Not registered.', ephemeral: true });

  _expirePending(matchId);
  const pending = pendingRequests.get(matchId);
  if (!pending) {
    return interaction.reply({ content: 'No pending cancel request for this match.', ephemeral: true });
  }

  const cap = _getCaptainForUser(match, user);
  if (!cap || cap.team === pending.requesterTeam) {
    return interaction.reply({
      content: 'Only the opposing captain can reject this request.',
      ephemeral: true,
    });
  }

  pendingRequests.delete(matchId);

  try {
    await interaction.update({
      content: `Cancel request **rejected** by <@${user.discord_id}>. Match continues.`,
      embeds: [],
      components: [],
    });
  } catch {
    await interaction.reply({ content: 'Rejected. Match continues.', ephemeral: true });
  }
}

// "Nevermind" on any of the confirm dialogs.
async function handleNevermind(interaction) {
  return interaction.update({
    content: 'Cancelled — match continues.',
    embeds: [],
    components: [],
  });
}

module.exports = {
  handleRequestButton,
  handleRequestConfirm,
  handleAcceptButton,
  handleAcceptConfirm,
  handleRejectButton,
  handleNevermind,
};

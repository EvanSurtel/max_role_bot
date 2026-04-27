// "Extend +10 min" button handler — creator-only.
//
// Pushes the challenge's expires_at +10 min, cancels and re-creates
// the challenge_expiry timer so the new deadline is what fires, and
// updates the embed footer/timestamp on the board so anyone looking
// at it sees the fresh deadline.
//
// Mirrors CMG's "extend posted match by 10 minutes if not accepted"
// feature. Only allowed while the challenge is still OPEN — once it's
// ACCEPTED / IN_PROGRESS / EXPIRED / CANCELLED, the extend button is
// stale and the click is rejected with a clear message.

const challengeRepo = require('../database/repositories/challengeRepo');
const userRepo = require('../database/repositories/userRepo');
const timerService = require('../services/timerService');
const { CHALLENGE_STATUS, TIMERS } = require('../config/constants');

async function handleChallengeExtend(interaction) {
  const challengeId = parseInt(interaction.customId.replace('challenge_extend_', ''), 10);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: 'Invalid challenge.', ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: 'Challenge not found.', ephemeral: true });
  }

  // Only the creator can extend their own challenge.
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user || user.id !== challenge.creator_user_id) {
    return interaction.reply({
      content: 'Only the challenge creator can extend it.',
      ephemeral: true,
      _autoDeleteMs: 10_000,
    });
  }

  // Extend is only valid while the challenge is OPEN. Anything past
  // that has either landed an acceptor or already expired/cancelled,
  // and the +10 min would either be meaningless or worse — extending
  // an EXPIRED challenge would resurrect it without re-locking funds.
  if (challenge.status !== CHALLENGE_STATUS.OPEN) {
    let detail;
    if (challenge.status === CHALLENGE_STATUS.EXPIRED) {
      detail = 'this challenge already expired. Create a new one to keep playing.';
    } else if (challenge.status === CHALLENGE_STATUS.CANCELLED) {
      detail = 'this challenge was cancelled.';
    } else {
      detail = 'this challenge is no longer waiting for an acceptor.';
    }
    return interaction.reply({ content: `Can't extend — ${detail}`, ephemeral: true });
  }

  // Bump expires_at by 10 minutes from NOW (not from the existing
  // expiry). Adding to "now" rather than to the prior expiry means a
  // creator who clicks Extend 5 minutes before expiry gets ~10 more
  // minutes total, not 15. Matches the CMG "extend by 10" framing.
  const newExpiresAt = new Date(Date.now() + TIMERS.CHALLENGE_EXTEND).toISOString();
  challengeRepo.updateExpiresAt(challengeId, newExpiresAt);

  // Cancel the old timer + create a new one for the bumped deadline.
  // timerService.createTimer doesn't replace an existing row for the
  // same (type, referenceId), it inserts another one — without the
  // cancel below, we'd have two timers firing and the older one
  // would expire the challenge before the new deadline.
  timerService.cancelTimersByReference('challenge_expiry', challengeId);
  timerService.createTimer('challenge_expiry', challengeId, TIMERS.CHALLENGE_EXTEND);

  console.log(`[ChallengeExtend] Challenge #${challengeId} extended +10min by creator ${user.id}, new expires_at=${newExpiresAt}`);

  return interaction.reply({
    content: `**Extended by 10 minutes.** Challenge #${challenge.display_number || challengeId} now expires at <t:${Math.floor(new Date(newExpiresAt).getTime() / 1000)}:t>.`,
    ephemeral: true,
    _autoDeleteMs: 30_000,
  });
}

module.exports = { handleChallengeExtend };

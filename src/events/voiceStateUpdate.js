// Voice-state listener for the queue ready-up flow.
//
// When a queued player joins their queue match's lobby voice channel,
// the bot auto-marks them ready (same effect as clicking Ready Up).
// We don't actually require voice — the button + voice are equivalent
// paths to the same end. This is just so a player who joins voice
// without thinking to click the button still gets credit.
//
// We don't unmark on leave: once you've signaled readiness, leaving
// voice doesn't undo it. Players who ready up then disconnect are
// staff's problem, not the bot's.

const { activeMatches } = require('../queue/state');

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState) {
    try {
      // Only act on JOIN (not leave/move-out).
      if (!newState.channelId || newState.channelId === oldState.channelId) return;

      const userId = newState.id;
      if (!userId) return;

      // Find the queue match whose lobby voice channel matches the
      // joined channel. Loop is short — at most a few active matches
      // at a time.
      const match = [...activeMatches.values()].find(
        m => m.voiceChannelId === newState.channelId,
      );
      if (!match) return;

      const { markPlayerReady } = require('../queue/matchLifecycle');
      await markPlayerReady(newState.client, match, userId);
    } catch (err) {
      console.error('[VoiceStateUpdate] handler error:', err.message);
    }
  },
};

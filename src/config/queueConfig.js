// Queue-specific constants for 5v5 Ranked Queue matches.
// All queue matches are 5v5 Hardpoint Bo3 — no user choice.

const QUEUE_CONFIG = {
  TEAM_SIZE: 5,                    // 5v5 queue
  TOTAL_PLAYERS: 10,
  SERIES_LENGTH: 3,                // Always Bo3
  GAME_MODE: 'hp',                 // Always Hardpoint

  // Timers (ms)
  VOICE_JOIN_TIMEOUT: 7.5 * 60 * 1000,    // 7.5 min to join voice
  CAPTAIN_VOTE_TIMEOUT: 25 * 1000,         // 25s to vote for captains
  CAPTAIN_PICK_TIMEOUT: 25 * 1000,         // 25s per captain pick
  ROLE_SELECT_TIMEOUT: 60 * 1000,          // 60s for role selection (covers operators too)
  PLAY_TIMEOUT: 10 * 60 * 1000,            // 10 min to play the match

  // XP
  WIN_XP: 100,
  LOSS_XP: 60,      // subtracted (negative)
  NO_SHOW_PENALTY: 300,
  DQ_PENALTY: 300,

  // Weapon roles and their max slots per team
  WEAPON_ROLES: {
    AR: { label: 'AR', max: 3, emoji: '🔫' },
    SMG: { label: 'SMG', max: 3, emoji: '⚡' },
    LMG: { label: 'LMG', max: 1, emoji: '💪' },
    SHOTGUN: { label: 'Shotgun', max: 1, emoji: '💥' },
    MARKSMAN: { label: 'Marksman', max: 1, emoji: '🎯' },
    SNIPER: { label: 'Sniper', max: 1, emoji: '🔭' },
  },

  // Operators (1 per team per operator, NOT 1 across both teams)
  OPERATORS: [
    'Annihilator', 'Claw', 'Death Machine', 'Equalizer',
    'Gravity Spikes', 'Gravity Vortex Gun', 'Purifier',
    'Sparrow', 'Tempest', 'War Machine',
  ],

  // Auto-assign priority for roles when timer expires (prefer AR then SMG)
  AUTO_ROLE_PRIORITY: ['AR', 'SMG', 'LMG', 'SHOTGUN', 'MARKSMAN', 'SNIPER'],
};

module.exports = QUEUE_CONFIG;

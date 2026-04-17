// src/queue/index.js — public API for the queue system.
//
// Re-exports everything that external code needs. Internal callers within
// src/queue/ should import from the specific file directly.

const state = require('./state');
const helpers = require('./helpers');
const matchLifecycle = require('./matchLifecycle');
const captainVote = require('./captainVote');
const captainPick = require('./captainPick');
const roleSelect = require('./roleSelect');
const playPhase = require('./playPhase');
const subCommands = require('./subCommands');
const interactions = require('./interactions');

module.exports = {
  // Queue management (state.js)
  joinQueue: state.joinQueue,
  leaveQueue: state.leaveQueue,
  getQueueSize: state.getQueueSize,
  getQueuePlayers: state.getQueuePlayers,
  isInQueue: state.isInQueue,
  isInActiveMatch: state.isInActiveMatch,

  // Match lookup (state.js)
  getMatch: state.getMatch,
  getMatchByChannel: state.getMatchByChannel,

  // Match lifecycle (matchLifecycle.js)
  createMatch: matchLifecycle.createMatch,
  handleNoShows: matchLifecycle.handleNoShows,
  resolveMatch: matchLifecycle.resolveMatch,
  cancelMatch: matchLifecycle.cancelMatch,

  // Helpers (helpers.js)
  findClosestXpReplacement: helpers.findClosestXpReplacement,

  // Captain vote (captainVote.js)
  startCaptainVote: captainVote.startCaptainVote,
  recordCaptainVote: captainVote.recordCaptainVote,
  finalizeCaptainVote: captainVote.finalizeCaptainVote,

  // Captain pick (captainPick.js)
  startCaptainPick: captainPick.startCaptainPick,
  recordCaptainPick: captainPick.recordCaptainPick,
  autoPickForCaptain: captainPick.autoPickForCaptain,

  // Role select (roleSelect.js)
  startRoleSelect: roleSelect.startRoleSelect,
  recordRoleChoice: roleSelect.recordRoleChoice,
  recordOperatorChoice: roleSelect.recordOperatorChoice,
  autoAssignRoles: roleSelect.autoAssignRoles,

  // Play phase (playPhase.js)
  startPlayPhase: playPhase.startPlayPhase,
  recordVote: playPhase.recordVote,

  // Sub management (subCommands.js)
  subPlayerOut: subCommands.subPlayerOut,

  // Interaction router (interactions.js)
  handleQueueInteraction: interactions.handleQueueInteraction,
};

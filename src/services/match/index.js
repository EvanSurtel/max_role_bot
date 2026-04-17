// Match service — re-exports public API.
// Backward-compatible: require('../services/matchService') still works via
// the matchService.js redirect, and require('../services/match') works directly.
const { createMatchRecord, startMatch } = require('./startMatch');
const { createMatchChannels } = require('./createChannels');
const { resolveMatch } = require('./resolveMatch');
const { cleanupChannels } = require('./cleanup');
const { postResultToChannels } = require('./helpers');

module.exports = {
  createMatchRecord,
  createMatchChannels,
  startMatch,
  resolveMatch,
  cleanupChannels,
  postResultToChannels,
};

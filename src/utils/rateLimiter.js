const { COOLDOWNS } = require('../config/constants');

// Map<discordId, Map<action, timestamp>>
const userCooldowns = new Map();

/**
 * Check if a user is on cooldown for an action.
 * @param {string} discordId
 * @param {string} action - Key from COOLDOWNS (e.g. 'CREATE_WAGER')
 * @returns {{ blocked: boolean, remainingSeconds: number }}
 */
function checkCooldown(discordId, action) {
  const cooldownMs = COOLDOWNS[action];
  if (!cooldownMs) return { blocked: false, remainingSeconds: 0 };

  const userMap = userCooldowns.get(discordId);
  if (!userMap) return { blocked: false, remainingSeconds: 0 };

  const lastUsed = userMap.get(action);
  if (!lastUsed) return { blocked: false, remainingSeconds: 0 };

  const elapsed = Date.now() - lastUsed;
  if (elapsed >= cooldownMs) {
    userMap.delete(action);
    return { blocked: false, remainingSeconds: 0 };
  }

  return { blocked: true, remainingSeconds: Math.ceil((cooldownMs - elapsed) / 1000) };
}

/**
 * Set a cooldown for a user action.
 * @param {string} discordId
 * @param {string} action
 */
function setCooldown(discordId, action) {
  if (!userCooldowns.has(discordId)) {
    userCooldowns.set(discordId, new Map());
  }
  userCooldowns.get(discordId).set(action, Date.now());
}

module.exports = { checkCooldown, setCooldown };

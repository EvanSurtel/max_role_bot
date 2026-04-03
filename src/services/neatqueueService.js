const API_BASE = 'https://api.neatqueue.com';

function getToken() {
  return process.env.NEATQUEUE_API_TOKEN || '';
}

function getChannelId() {
  return process.env.NEATQUEUE_CHANNEL_ID || '';
}

function getGuildId() {
  return process.env.GUILD_ID || '';
}

/**
 * Returns true if the NeatQueue integration is configured (token + channel ID present).
 */
function isConfigured() {
  return Boolean(getToken()) && Boolean(getChannelId());
}

/**
 * Make an authenticated request to the NeatQueue API.
 * @param {string} path - API path (e.g. /api/v2/add/stats)
 * @param {object} options - fetch options override
 * @returns {Promise<object|null>} Parsed JSON response or null on error
 */
async function neatqueueFetch(path, options = {}) {
  const token = getToken();
  if (!token) {
    console.warn('[NeatQueue] API token not configured, skipping request');
    return null;
  }

  const url = `${API_BASE}${path}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  try {
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[NeatQueue] API error ${res.status} for ${options.method || 'GET'} ${path}: ${body}`);
      return null;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.error(`[NeatQueue] Request failed for ${path}:`, err.message);
    return null;
  }
}

/**
 * Add (or subtract) points for a player in the NeatQueue queue.
 * @param {string} discordUserId - The Discord user ID
 * @param {number} amount - Points to add (negative to subtract)
 */
async function addPoints(discordUserId, amount) {
  if (!isConfigured()) return null;

  return neatqueueFetch('/api/v2/add/stats', {
    method: 'POST',
    body: JSON.stringify({
      channel_id: parseInt(getChannelId()),
      stat: 'points',
      value: amount,
      user_id: parseInt(discordUserId),
    }),
  });
}

/**
 * Get player stats from NeatQueue.
 * @param {string} discordUserId - The Discord user ID
 * @returns {Promise<object|null>} Player stats or null
 */
async function getPlayerStats(discordUserId) {
  if (!isConfigured()) return null;

  const guildId = getGuildId();
  return neatqueueFetch(`/api/v1/playerstats/${guildId}/${discordUserId}`);
}

module.exports = { addPoints, getPlayerStats, isConfigured };

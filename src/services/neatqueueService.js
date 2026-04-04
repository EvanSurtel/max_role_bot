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

function isConfigured() {
  return Boolean(getToken()) && Boolean(getChannelId());
}

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
 * Add (or subtract) points for a player.
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
 * Add a win for a player (increments win count by 1).
 */
async function addWin(discordUserId) {
  if (!isConfigured()) return null;
  return neatqueueFetch('/api/v2/add/stats', {
    method: 'POST',
    body: JSON.stringify({
      channel_id: parseInt(getChannelId()),
      stat: 'wins',
      value: 1,
      user_id: parseInt(discordUserId),
    }),
  });
}

/**
 * Add a loss for a player (increments loss count by 1).
 */
async function addLoss(discordUserId) {
  if (!isConfigured()) return null;
  return neatqueueFetch('/api/v2/add/stats', {
    method: 'POST',
    body: JSON.stringify({
      channel_id: parseInt(getChannelId()),
      stat: 'losses',
      value: 1,
      user_id: parseInt(discordUserId),
    }),
  });
}

/**
 * Get player stats from NeatQueue.
 */
async function getPlayerStats(discordUserId) {
  if (!isConfigured()) return null;
  const guildId = getGuildId();
  return neatqueueFetch(`/api/v1/playerstats/${guildId}/${discordUserId}`);
}

/**
 * Get the full leaderboard/stats for all players in the queue channel.
 * Returns array of player stats sorted by points.
 */
async function getChannelLeaderboard() {
  if (!isConfigured()) return null;
  const guildId = getGuildId();
  const channelId = getChannelId();
  return neatqueueFetch(`/api/v1/leaderboard/${guildId}/${channelId}`);
}

module.exports = { addPoints, addWin, addLoss, getPlayerStats, getChannelLeaderboard, isConfigured };

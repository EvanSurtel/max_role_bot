// NeatQueue API client — push XP/wins/losses, fetch leaderboard.
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
 * Add (or subtract) points for a player. Incremental — this ADDS
 * `amount` to whatever NeatQueue already has for that user. Use
 * setPoints() below if you want to land on an exact value.
 */
async function addPoints(discordUserId, amount) {
  if (!isConfigured()) return null;
  return neatqueueFetch('/api/v2/add/stats', {
    method: 'POST',
    body: JSON.stringify({
      channel_id: getChannelId(),
      stat: 'points',
      value: amount,
      user_id: String(discordUserId),
    }),
  });
}

/**
 * SET a player's points to an exact value. NeatQueue's /add/stats
 * endpoint is additive only (no setter), so this implementation
 * reads the current points from the channel leaderboard and then
 * calls addPoints() with the delta needed to land on `target`.
 *
 * Use this when seeding a fresh user or forcing a season-reset
 * baseline — `addPoints(user, 500)` would have stacked on top of
 * any existing value and silently handed out 1500 / 2000 / etc.
 *
 * Falls back to a pure addPoints(target) only if the leaderboard
 * lookup fails entirely — better to seed than to crash.
 */
async function setPoints(discordUserId, target) {
  if (!isConfigured()) return null;
  const targetId = String(discordUserId);
  try {
    const raw = await getChannelLeaderboard();
    const arr = Array.isArray(raw)
      ? raw
      : (raw && (raw.leaderboard || raw.data || raw.players || raw.entries)) || [];
    const entry = Array.isArray(arr) ? arr.find(e => {
      const uid = String(e.user_id || e.userId || e.id || e.discord_id || e.discordId || '');
      return uid === targetId;
    }) : null;
    const current = entry
      ? Number(entry.points ?? entry.score ?? (entry.stats && entry.stats.points) ?? entry.xp ?? 0)
      : 0;
    const delta = target - current;
    if (delta === 0) return { current, delta, target };
    await addPoints(discordUserId, delta);
    return { current, delta, target };
  } catch (err) {
    console.warn(`[NeatQueue] setPoints(${targetId} → ${target}) fell back to pure addPoints: ${err.message}`);
    return addPoints(discordUserId, target);
  }
}

/**
 * Add a win for a player (increments win count by 1).
 */
async function addWin(discordUserId) {
  if (!isConfigured()) return null;
  return neatqueueFetch('/api/v2/add/stats', {
    method: 'POST',
    body: JSON.stringify({
      channel_id: getChannelId(),
      stat: 'wins',
      value: 1,
      user_id: String(discordUserId),
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
      channel_id: getChannelId(),
      stat: 'losses',
      value: 1,
      user_id: String(discordUserId),
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

/**
 * Get paginated leaderboard from NeatQueue's v2 API with selectable fields.
 *
 * @param {object} options
 * @param {number} [options.page=1]         - 1-based page number
 * @param {number} [options.pageSize=10]    - entries per page
 * @param {string} [options.includeFields]  - comma-separated list of fields to include
 * @returns {object|null} API response or null on error
 */
async function getLeaderboardV2({ page = 1, pageSize = 10, includeFields } = {}) {
  if (!isConfigured()) return null;
  const guildId = getGuildId();
  const channelId = getChannelId();
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (includeFields) params.set('include_fields', includeFields);
  return neatqueueFetch(`/api/v2/leaderboard/${guildId}/${channelId}?${params.toString()}`);
}

/**
 * Get detailed player stats including game history.
 *
 * @param {string} discordUserId - Discord user ID
 * @returns {object|null} Player stats with game history or null on error
 */
async function getPlayerStatsDetailed(discordUserId) {
  if (!isConfigured()) return null;
  const guildId = getGuildId();
  return neatqueueFetch(`/api/v1/playerstats/${guildId}/${discordUserId}?include_games=true`);
}

module.exports = {
  addPoints, setPoints, addWin, addLoss,
  getPlayerStats, getPlayerStatsDetailed,
  getChannelLeaderboard, getLeaderboardV2,
  isConfigured,
};

// Random map pool selection for match series.
const { MAP_POOLS, MODE_ROTATIONS } = require('../config/constants');

/**
 * Generate random map selections for a match series.
 * Avoids repeating maps within the same mode when possible.
 *
 * @param {string} gameMode - The game mode key (e.g. 'hp', 'hp_snd', 'hp_ctrl_snd')
 * @param {number} seriesLength - Number of games (1, 3, 5, or 7)
 * @returns {{ game: number, mode: string, map: string }[]}
 */
function pickMaps(gameMode, seriesLength) {
  const rotation = MODE_ROTATIONS[gameMode];
  if (!rotation) return [];

  const modes = rotation(seriesLength); // e.g. ['HP', 'S&D', 'HP'] for Bo3 hp_snd
  const usedByMode = {}; // track used maps per mode to avoid repeats

  return modes.map((mode, i) => {
    const pool = MAP_POOLS[mode];
    if (!pool || pool.length === 0) {
      return { game: i + 1, mode, map: 'TBD' };
    }

    if (!usedByMode[mode]) usedByMode[mode] = [];

    // Get available maps (not yet used for this mode)
    let available = pool.filter(m => !usedByMode[mode].includes(m));

    // If all maps used, reset (allows repeats in long series)
    if (available.length === 0) {
      usedByMode[mode] = [];
      available = [...pool];
    }

    // Pick random
    const map = available[Math.floor(Math.random() * available.length)];
    usedByMode[mode].push(map);

    return { game: i + 1, mode, map };
  });
}

/**
 * Format map picks into a readable string for Discord.
 */
function formatMapPicks(picks) {
  return picks.map(p => `**Game ${p.game}:** ${p.mode} — ${p.map}`).join('\n');
}

module.exports = { pickMaps, formatMapPicks };

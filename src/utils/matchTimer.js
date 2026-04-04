const { MODE_ROTATIONS, MAP_DURATION_MINUTES, MATCH_TIMERS } = require('../config/constants');

/**
 * Calculate estimated match duration in minutes based on game mode and series length.
 * @param {string} gameMode - Game mode key (e.g. 'hp', 'hp_snd')
 * @param {number} seriesLength - Number of games (1, 3, 5, 7)
 * @returns {number} Estimated duration in minutes
 */
function estimateMatchDuration(gameMode, seriesLength) {
  const rotation = MODE_ROTATIONS[gameMode];
  if (!rotation) return seriesLength * 12; // fallback 12 min per map

  const modes = rotation(seriesLength);
  let totalMinutes = 0;

  for (const mode of modes) {
    totalMinutes += MAP_DURATION_MINUTES[mode] || 12;
  }

  // Add 2 min buffer per map for loading, lobby, etc.
  totalMinutes += seriesLength * 2;

  return totalMinutes;
}

/**
 * Calculate the no-show deadline (ms from now).
 */
function getNoShowDeadlineMs() {
  return MATCH_TIMERS.NO_SHOW * 60 * 1000;
}

/**
 * Calculate when reporting should open (ms from match start).
 * This is the estimated match duration — reporting is available after this.
 */
function getReportOpenMs(gameMode, seriesLength) {
  const durationMin = estimateMatchDuration(gameMode, seriesLength);
  return durationMin * 60 * 1000;
}

/**
 * Calculate auto-dispute deadline (ms from match start).
 * If no reports by this time, match is auto-disputed.
 */
function getAutoDisputeMs(gameMode, seriesLength) {
  const durationMin = estimateMatchDuration(gameMode, seriesLength);
  return (durationMin + MATCH_TIMERS.REPORT_WINDOW + MATCH_TIMERS.REPORT_BUFFER) * 60 * 1000;
}

/**
 * Format minutes into human-readable string.
 */
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

module.exports = {
  estimateMatchDuration,
  getNoShowDeadlineMs,
  getReportOpenMs,
  getAutoDisputeMs,
  formatDuration,
};

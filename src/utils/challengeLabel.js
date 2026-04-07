/**
 * Get the proper display label for a challenge.
 * Returns "Wager #3" or "XP Match #5" with type-specific numbering.
 */
function getChallengeLabel(challenge) {
  const typeLabel = challenge.type === 'wager' ? 'Wager' : 'XP Match';
  const num = challenge.display_number || challenge.id;
  return `${typeLabel} #${num}`;
}

/**
 * Get the type label without number.
 */
function getTypeLabel(challenge) {
  return challenge.type === 'wager' ? 'Wager' : 'XP Match';
}

module.exports = { getChallengeLabel, getTypeLabel };

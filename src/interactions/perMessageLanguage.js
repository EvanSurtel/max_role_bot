// Per-message language switcher.
//
// Some channels have many independent messages — the wager challenges
// board has one message per open challenge, the results channels have
// one message per finished match. The user can't get a "channel-wide"
// language ephemeral for these because each message has its own
// content. So each individual message gets its own 🌐 button that
// shows JUST that one item in the user's chosen language.
//
// Flow:
//   1. User clicks 🌐 on a specific challenge (or result) message
//   2. Bot replies ephemerally with a language picker dropdown
//   3. User picks a language
//   4. Bot updates the ephemeral to show THAT specific challenge (or
//      result) rendered in the new language, with functional buttons
//      where applicable (Accept Challenge, Cancel, etc.)
//
// CustomId encoding:
//   pml_show_ch_{challengeId}      → open picker for a challenge
//   pml_show_res_{matchId}         → open picker for a match result
//   pml_pick_ch_{challengeId}      → user picked language for a challenge
//   pml_pick_res_{matchId}         → user picked language for a match result

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { t, langFor } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');
const userRepo = require('../database/repositories/userRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const matchRepo = require('../database/repositories/matchRepo');
const { challengeEmbed, matchResultEmbed } = require('../utils/embeds');

/**
 * Build the language picker select menu with a context-encoded customId.
 */
function _buildPickerRow(customId, currentLang) {
  const options = Object.entries(SUPPORTED_LANGUAGES).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === currentLang,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(t('language_panel.placeholder', currentLang))
      .addOptions(options),
  );
}

// ─── Challenges ──────────────────────────────────────────────────

/**
 * Handle the 🌐 button click on a specific challenge in the
 * challenges board. Replies with an ephemeral language picker.
 */
async function handleShowLangForChallenge(interaction) {
  const challengeId = parseInt(interaction.customId.replace('pml_show_ch_', ''), 10);
  const lang = langFor(interaction);

  const row = _buildPickerRow(`pml_pick_ch_${challengeId}`, lang);

  await interaction.reply({
    content: 'Pick a language to view this challenge:',
    components: [row],
    ephemeral: true,
    _persist: true,
  });
}

/**
 * Handle the user picking a language from the challenge ephemeral.
 * Saves the language and updates the ephemeral to show the challenge
 * in the new language with functional Accept Challenge / Cancel buttons.
 */
async function handlePickLangForChallenge(interaction) {
  const newLang = interaction.values[0];
  if (!SUPPORTED_LANGUAGES[newLang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  const challengeId = parseInt(interaction.customId.replace('pml_pick_ch_', ''), 10);
  // Per-message only — do NOT save globally. Just re-render this message.

  // Look up the challenge
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.update({
      content: t('per_message_lang.not_found', newLang),
      components: [],
      embeds: [],
    });
  }

  // Build the localized challenge embed
  let teamPlayers = null;
  if (!challenge.is_anonymous) {
    const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 1);
    teamPlayers = players.map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? { discord_id: u.discord_id, cod_ign: u.cod_ign } : null;
    }).filter(Boolean);
  }
  const embed = challengeEmbed(challenge, !!challenge.is_anonymous, teamPlayers, newLang);

  // Functional Accept + Cancel buttons in the user's new language
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge_accept_${challenge.id}`)
      .setLabel(t('challenge_create.btn_accept_challenge', newLang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`challenge_cancel_${challenge.id}`)
      .setLabel(t('challenge_create.btn_cancel_challenge', newLang))
      .setStyle(ButtonStyle.Danger),
  );

  return interaction.update({
    content: '',
    embeds: [embed],
    components: [row],
  });
}

// ─── Match results ───────────────────────────────────────────────

/**
 * Handle the 🌐 button click on a specific match result message.
 */
async function handleShowLangForResult(interaction) {
  const matchId = parseInt(interaction.customId.replace('pml_show_res_', ''), 10);
  const lang = langFor(interaction);

  const row = _buildPickerRow(`pml_pick_res_${matchId}`, lang);

  await interaction.reply({
    content: 'Pick a language to view this result:',
    components: [row],
    ephemeral: true,
    _persist: true,
  });
}

/**
 * Handle the user picking a language from a result ephemeral.
 */
async function handlePickLangForResult(interaction) {
  const newLang = interaction.values[0];
  if (!SUPPORTED_LANGUAGES[newLang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  const matchId = parseInt(interaction.customId.replace('pml_pick_res_', ''), 10);
  const discordId = interaction.user.id;

  // Per-message only — do NOT save globally. Just re-render this message.

  // Look up the match + challenge
  const match = matchRepo.findById(matchId);
  if (!match) {
    return interaction.update({
      content: t('per_message_lang.not_found', newLang),
      components: [],
      embeds: [],
    });
  }
  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) {
    return interaction.update({
      content: t('per_message_lang.not_found', newLang),
      components: [],
      embeds: [],
    });
  }

  // Re-derive winners/losers from the match.winning_team and player records
  const allPlayers = challengePlayerRepo.findByChallengeId(challenge.id);
  const winningTeam = match.winning_team || 0;
  const winningPlayers = allPlayers.filter(p => p.team === winningTeam);
  const losingPlayers = allPlayers.filter(p => p.team !== winningTeam && p.team !== 0);

  // We don't have winXp/loseXp in this context — pull them from the
  // xp_history table for this match if available, otherwise leave as 0.
  let winXp = 0;
  let loseXp = 0;
  try {
    const db = require('../database/db');
    const winnerXp = db.prepare('SELECT xp_amount FROM xp_history WHERE match_id = ? AND xp_amount > 0 LIMIT 1').get(match.id);
    const loserXp = db.prepare('SELECT xp_amount FROM xp_history WHERE match_id = ? AND xp_amount < 0 LIMIT 1').get(match.id);
    if (winnerXp) winXp = winnerXp.xp_amount;
    if (loserXp) loseXp = Math.abs(loserXp.xp_amount);
  } catch { /* */ }

  const embed = matchResultEmbed(
    match,
    challenge,
    winningPlayers,
    losingPlayers,
    userRepo,
    winXp,
    loseXp,
    winningTeam,
    newLang,
  );

  return interaction.update({
    content: '',
    embeds: [embed],
    components: [],
  });
}

/**
 * Build the language button to attach to a per-challenge message.
 */
function buildChallengeLanguageButton(challengeId, lang = 'en') {
  return new ButtonBuilder()
    .setCustomId(`pml_show_ch_${challengeId}`)
    .setEmoji('🌐')
    .setLabel(t('common.btn_language', lang))
    .setStyle(ButtonStyle.Secondary);
}

/**
 * Build the language button to attach to a per-result message.
 */
function buildResultLanguageButton(matchId, lang = 'en') {
  return new ButtonBuilder()
    .setCustomId(`pml_show_res_${matchId}`)
    .setEmoji('🌐')
    .setLabel(t('common.btn_language', lang))
    .setStyle(ButtonStyle.Secondary);
}

/**
 * Build an inline language dropdown row for a challenge message.
 * Skips the button click step — user picks language directly from the dropdown.
 */
function buildChallengeLanguageDropdown(challengeId, lang = 'en') {
  return _buildPickerRow(`pml_pick_ch_${challengeId}`, lang);
}

/**
 * Build an inline language dropdown row for a result message.
 */
function buildResultLanguageDropdown(matchId, lang = 'en') {
  return _buildPickerRow(`pml_pick_res_${matchId}`, lang);
}

module.exports = {
  handleShowLangForChallenge,
  handlePickLangForChallenge,
  handleShowLangForResult,
  handlePickLangForResult,
  buildChallengeLanguageButton,
  buildResultLanguageButton,
  buildChallengeLanguageDropdown,
  buildResultLanguageDropdown,
};

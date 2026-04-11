// Ephemeral panel dispatcher.
//
// When a user changes their language from a channel, the bot can't
// modify the SHARED panel in that channel (Discord doesn't allow
// per-viewer rendering). Instead, this dispatcher detects which
// channel the user was in when they changed language, builds the
// equivalent panel content rendered in their NEW language, and sends
// it as one or more ephemeral follow-up messages — visible only to
// them, with the same functional buttons as the public panel.
//
// So when a user in the lobby changes language to Spanish, they get
// an ephemeral lobby in Spanish with the Create Wager / XP Match
// buttons functional. Same for welcome (TOS + Accept/Decline), rules,
// howItWorks, wallet, and the leaderboard channels.

const { ActionRowBuilder } = require('discord.js');

// Same chunking logic as the howItWorks/rules posting functions —
// stay under Discord's per-message limits.
const CHUNK_CHAR_CAP = 5500;
const CHUNK_EMBED_CAP = 10;

function _embedChars(embed) {
  const data = embed.data || embed;
  let chars = (data.title || '').length + (data.description || '').length;
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) {
      chars += (f.name || '').length + (f.value || '').length;
    }
  }
  if (data.footer && data.footer.text) chars += data.footer.text.length;
  return chars;
}

function _packEmbeds(embeds) {
  const groups = [];
  let current = [];
  let chars = 0;
  for (const e of embeds) {
    const ec = _embedChars(e);
    if (current.length > 0 && (current.length >= CHUNK_EMBED_CAP || chars + ec > CHUNK_CHAR_CAP)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(e);
    chars += ec;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Send an ephemeral version of the panel that lives in the given
 * channel, rendered in the user's NEW language.
 *
 * Caller must have already deferred the reply (via deferReply ephemeral)
 * so we can editReply for the first chunk and followUp for additional
 * chunks. This makes the auto-replace wrapper see ONE ephemeral session
 * (not multiple disconnected replies).
 *
 * @param {import('discord.js').Interaction} interaction - the language picker interaction (already deferred ephemerally)
 * @param {string} newLang - the language the user just picked
 */
async function sendEphemeralPanelForCurrentChannel(interaction, newLang) {
  const channelId = interaction.channel?.id;
  if (!channelId) return;

  try {
    // Welcome channel → TOS + Accept/Decline buttons
    if (channelId === process.env.WELCOME_CHANNEL_ID) {
      const { buildWelcomePanel } = require('../panels/welcomePanel');
      return interaction.editReply(buildWelcomePanel(newLang));
    }

    // Lobby (wager channel)
    if (channelId === process.env.WAGER_CHANNEL_ID) {
      const { buildLobbyPanel } = require('../panels/lobbyPanel');
      return interaction.editReply(buildLobbyPanel(newLang));
    }

    // XP match channel
    if (channelId === process.env.XP_MATCH_CHANNEL_ID) {
      const { buildXpMatchPanel } = require('../panels/xpMatchPanel');
      return interaction.editReply(buildXpMatchPanel(newLang));
    }

    // Public wallet channel
    if (channelId === process.env.WALLET_CHANNEL_ID) {
      const { buildPublicWalletPanel } = require('../panels/publicWalletPanel');
      return interaction.editReply(buildPublicWalletPanel(newLang));
    }

    // Rules channel → multi-message ephemeral
    if (channelId === process.env.RULES_CHANNEL_ID) {
      const { buildRulesEmbeds } = require('../panels/rulesPanel');
      return _sendPackedEphemeral(interaction, buildRulesEmbeds(newLang));
    }

    // How It Works channel → multi-message ephemeral
    if (channelId === process.env.HOW_IT_WORKS_CHANNEL_ID) {
      const { buildHowItWorksEmbeds } = require('../panels/howItWorksPanel');
      return _sendPackedEphemeral(interaction, buildHowItWorksEmbeds(newLang));
    }

    // Ranks channel → build the panel WITHOUT thumbnails for the
    // ephemeral. Re-uploading 8 PNG files every time someone switches
    // language would hammer Discord's rate limits; the public panel in
    // the channel already has all emblems, so the ephemeral is just
    // the translated text.
    if (channelId === process.env.RANKS_CHANNEL_ID) {
      const { buildRanksPanel } = require('../panels/ranksPanel');
      const { embeds } = buildRanksPanel(newLang, { withThumbnails: false });
      return _sendPackedEphemeral(interaction, embeds);
    }

    // XP leaderboard
    if (channelId === process.env.XP_LEADERBOARD_CHANNEL_ID) {
      const { buildXpPanel } = require('../panels/leaderboardPanel');
      return interaction.editReply(await buildXpPanel('global', 'season', null, newLang));
    }

    // Earnings leaderboard
    if (channelId === process.env.EARNINGS_LEADERBOARD_CHANNEL_ID) {
      const { buildEarningsPanel } = require('../panels/leaderboardPanel');
      return interaction.editReply(await buildEarningsPanel('global', newLang));
    }

    // Unknown channel — just confirm the language was saved
    const { t } = require('../locales/i18n');
    const { SUPPORTED_LANGUAGES } = require('../locales');
    const langName = SUPPORTED_LANGUAGES[newLang]?.nativeName || newLang;
    return interaction.editReply({
      content: t('onboarding.language_saved', newLang, { language: langName }),
    });
  } catch (err) {
    console.error('[EphPanel] Failed to send ephemeral panel:', err.message);
  }
}

/**
 * Send multi-message ephemeral by packing embeds into Discord-safe
 * chunks. First chunk goes via editReply (replacing the deferred
 * reply); additional chunks go via followUp (which the auto-replace
 * wrapper tracks as part of the same session).
 */
async function _sendPackedEphemeral(interaction, embeds) {
  const groups = _packEmbeds(embeds);
  if (groups.length === 0) return;

  // First chunk → editReply on the deferred ephemeral
  await interaction.editReply({ embeds: groups[0] });

  // Remaining chunks → ephemeral followUps (tracked by the wrapper)
  for (let i = 1; i < groups.length; i++) {
    await interaction.followUp({
      embeds: groups[i],
      ephemeral: true,
      _persist: true,
    });
  }
}

module.exports = { sendEphemeralPanelForCurrentChannel };

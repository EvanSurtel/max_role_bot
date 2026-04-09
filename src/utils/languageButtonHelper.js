// Shared helper for adding a language picker to any bot panel.
//
// The picker is a StringSelectMenu placed DIRECTLY on the shared
// panel message — not behind a button. Discord select menus on shared
// messages are interactive: when a user picks an option the bot gets
// an interaction it can respond to ephemerally, but the dropdown's
// "current selection" state is per-viewer client-side and doesn't
// persist on the shared message. So one user picking French doesn't
// change anything visible to other users.
//
// When a user picks a language:
//   1. The bot saves their preference
//   2. The bot replies ephemerally with the current channel's panel
//      content rendered in their new language (with functional buttons)
//   3. Their previous ephemeral session (if any) is auto-deleted by
//      the interactionCreate wrapper, so they only see ONE ephemeral
//
// Old "🌐 Language" button + intermediate picker is gone.

const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');

/**
 * Build a row containing the inline language picker dropdown. Place
 * this as one of your action rows on any panel that should support
 * per-user language switching.
 *
 * @param {string} lang - the panel's current display language, used
 *                        for the placeholder text and the "default"
 *                        option (purely cosmetic; no shared state)
 */
function buildLanguageDropdownRow(lang = 'en') {
  const options = Object.entries(SUPPORTED_LANGUAGES).slice(0, 25).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === lang,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('inline_lang_select')
      .setPlaceholder(`🌐 ${t('common.btn_language', lang)}`)
      .addOptions(options),
  );
}

module.exports = { buildLanguageDropdownRow };

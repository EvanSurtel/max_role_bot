// Shared helper for adding a language picker to any bot panel.
//
// The picker is a StringSelectMenu placed DIRECTLY on the shared
// panel message (not behind a button). A 🔄 Refresh button sits on
// its own row next to it. Together they let any user switch into any
// language and re-open the ephemeral in their current language even
// if they dismissed the previous one.
//
// When a user picks a language from the dropdown:
//   1. The bot saves their preference
//   2. The bot replies ephemerally with the current channel's panel
//      content rendered in their new language (with functional buttons)
//
// When a user clicks the Refresh button:
//   1. The bot re-renders the current channel's panel in whatever
//      language is already saved on their user row — no save needed
//   2. Works as a "give me the ephemeral again" escape hatch when
//      they dismissed the previous one and want it back in their
//      current language
//
// NOTE: Discord select menus only fire `interactionCreate` when the
// picked value CHANGES. We deliberately do NOT mark the user's current
// language as `default: true` — that way picking the same language
// you're already on still fires an event (and just re-renders).

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');

/**
 * Build the rows for the inline language controls. Returns an ARRAY
 * of action rows — callers should spread the return value into their
 * components list:
 *
 *   components: [actionRow, ...buildLanguageDropdownRow(lang)]
 *
 * Returns [dropdownRow, refreshButtonRow]. The refresh button lives
 * on its own row because Discord doesn't allow a select menu and a
 * button in the same action row.
 *
 * @param {string} lang - the panel's current display language, used
 *                        only for the placeholder/button label text
 */
function buildLanguageDropdownRow(lang = 'en') {
  const options = Object.entries(SUPPORTED_LANGUAGES).slice(0, 25).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    // No `default: code === lang` here — see note at top of file.
  }));

  const dropdownRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('inline_lang_select')
      .setPlaceholder(`🌐 ${t('common.btn_language', lang)}`)
      .addOptions(options),
  );

  const refreshRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lang_refresh')
      .setEmoji('🔄')
      .setLabel(t('common.btn_language', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return [dropdownRow, refreshRow];
}

module.exports = { buildLanguageDropdownRow };

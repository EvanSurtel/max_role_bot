// Shared wallet panel view builder.
// Both the onboarding flow (initial post) and the wallet refresh handler use
// this so the wallet message stays in sync with the user's chosen language.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');
const { USDC_PER_UNIT } = require('../config/constants');

/**
 * Build the main wallet view shown in a user's private wallet channel.
 *
 * @param {object} wallet - wallet row from walletRepo
 * @param {object} user - user row from userRepo (for username + saved language)
 * @param {string} lang - language code
 * @param {string|null} solLamports - SOL balance in lamports, or null if unknown yet
 */
function buildWalletView(wallet, user, lang, solLamports = null) {
  const availableUsdc = (Number(wallet.balance_available) / USDC_PER_UNIT).toFixed(2);
  const heldUsdc = (Number(wallet.balance_held) / USDC_PER_UNIT).toFixed(2);
  const solFormatted = solLamports !== null
    ? `${(Number(solLamports) / 1_000_000_000).toFixed(8)} SOL`
    : '—';

  const username = (user && (user.server_username || user.cod_ign)) || 'Player';

  const embed = new EmbedBuilder()
    .setTitle(t('wallet_embed.title', lang, { username }))
    .setColor(0x2ecc71)
    .setDescription(t('wallet.deposit_info', lang, { address: wallet.solana_address }))
    .addFields(
      { name: t('wallet_embed.available', lang), value: `$${availableUsdc} USDC`, inline: true },
      { name: t('wallet_embed.held', lang), value: `$${heldUsdc} USDC`, inline: true },
      { name: t('wallet.sol_balance', lang), value: solFormatted, inline: true },
    )
    .setFooter({ text: t('wallet_embed.footer', lang) })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wallet_copy_address').setLabel(t('wallet.btn_copy_address', lang)).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('wallet_refresh').setLabel('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wallet_withdraw').setLabel(t('wallet.btn_withdraw_usdc', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('wallet_withdraw_sol').setLabel(t('wallet.btn_withdraw_sol', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('wallet_history').setLabel(t('wallet.btn_history', lang)).setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wallet_lang').setLabel(`🌐 ${t('wallet.btn_language', lang)}`).setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Build the language picker view shown when a user clicks the Language button
 * inside their wallet channel. Renders an ephemeral-feeling embed plus a
 * StringSelectMenu listing every supported language.
 */
function buildLanguagePickerView(currentLang) {
  const lang = currentLang;

  const embed = new EmbedBuilder()
    .setTitle(t('wallet.language_picker_title', lang))
    .setColor(0x3498db)
    .setDescription(t('wallet.language_picker_desc', lang));

  const options = Object.entries(SUPPORTED_LANGUAGES).slice(0, 25).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === lang,
  }));

  const select = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('wallet_lang_select')
      .setPlaceholder('🌐 Language / Idioma / Idioma')
      .addOptions(options)
  );

  // Cancel button to go back to the wallet view
  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_lang_cancel')
      .setLabel(t('common.cancel', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [select, cancelRow] };
}

module.exports = { buildWalletView, buildLanguagePickerView };

// Withdraw choice screen — Cash Out (fiat offramp) vs Send (wallet transfer).
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { t } = require('../../locales/i18n');

/**
 * Show the withdraw choice menu: Cash Out to fiat or Send to wallet.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} lang - Locale code.
 */
function handleWithdrawMenu(interaction, lang) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_cashout')
      .setLabel(t('wallet.withdraw_choice_btn_fiat', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wallet_withdraw')
      .setLabel(t('wallet.withdraw_choice_btn_send', lang))
      .setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content: t('wallet.withdraw_choice_prompt', lang),
    components: [row],
    ephemeral: true,
  });
}

module.exports = { handleWithdrawMenu };

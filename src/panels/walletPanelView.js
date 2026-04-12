// Shared wallet panel view builder.
// Both the onboarding flow (initial post) and the wallet refresh handler use
// this so the wallet message stays in sync with the user's chosen language.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');
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

  // Language picker is in the welcome panel and dedicated language channel,
  // not here. The wallet panel still renders in the user's saved language.
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wallet_copy_address').setLabel(t('wallet.btn_copy_address', lang)).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('wallet_refresh').setLabel('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wallet_withdraw').setLabel(t('wallet.btn_withdraw_usdc', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('wallet_withdraw_sol').setLabel(t('wallet.btn_withdraw_sol', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('wallet_history').setLabel(t('wallet.btn_history', lang)).setStyle(ButtonStyle.Secondary),
  );

  // MoonPay fiat on-ramp / off-ramp. Always shown on the wallet —
  // the handlers refuse gracefully if MoonPay isn't configured so
  // users see a clear "not set up" message instead of a silent fail.
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_moonpay_deposit')
      .setLabel('💳 Deposit using Credit/Debit Card')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('wallet_moonpay_withdraw')
      .setLabel('🏦 Cash Out to Bank')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

module.exports = { buildWalletView };

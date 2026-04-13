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
 * @param {string|null} gasBalance - ETH balance in wei (string), or null if unknown
 */
function buildWalletView(wallet, user, lang, gasBalance = null) {
  const { ethers } = require('ethers');
  const availableUsdc = (Number(wallet.balance_available) / USDC_PER_UNIT).toFixed(2);
  const heldUsdc = (Number(wallet.balance_held) / USDC_PER_UNIT).toFixed(2);
  const gasFormatted = gasBalance !== null
    ? `${ethers.formatEther(gasBalance)} ETH`
    : '—';

  const username = (user && (user.server_username || user.cod_ign)) || 'Player';

  const embed = new EmbedBuilder()
    .setTitle(t('wallet_embed.title', lang, { username }))
    .setColor(0x2ecc71)
    .setDescription(t('wallet.deposit_info', lang, { address: wallet.solana_address }))
    .addFields(
      { name: t('wallet_embed.available', lang), value: `$${availableUsdc} USDC`, inline: true },
      { name: t('wallet_embed.held', lang), value: `$${heldUsdc} USDC`, inline: true },
      { name: 'ETH (gas)', value: gasFormatted, inline: true },
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

  // MoonPay fiat on-ramp / off-ramp buttons — each one is conditional
  // on whether the bot has the config it actually needs to drive it.
  //
  //   Deposit (on-ramp): only needs MOONPAY_API_KEY + MOONPAY_SECRET_KEY.
  //     MoonPay sends USDC to the user's bot wallet and the existing
  //     deposit poller credits them — webhooks aren't required.
  //
  //   Cash Out (off-ramp): needs the above PLUS MOONPAY_WEBHOOK_SECRET
  //     and WEBHOOK_PUBLIC_URL. The bot can't complete an off-ramp
  //     without MoonPay webhooks because that's how MoonPay delivers
  //     the deposit address the bot needs to send USDC to. If either
  //     is missing, we hide the button entirely so users don't start
  //     a flow that would silently strand.
  //
  // If the entire MoonPay integration is unconfigured, row2 is skipped
  // and the wallet view stays at its classic single-row layout.
  const moonpay = require('../services/moonpay');
  const moonpayRow = new ActionRowBuilder();
  if (moonpay.isConfigured()) {
    moonpayRow.addComponents(
      new ButtonBuilder()
        .setCustomId('wallet_moonpay_deposit')
        .setLabel('💳 Deposit using Credit/Debit Card')
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (moonpay.isOfframpConfigured()) {
    moonpayRow.addComponents(
      new ButtonBuilder()
        .setCustomId('wallet_moonpay_withdraw')
        .setLabel('🏦 Cash Out to Bank')
        .setStyle(ButtonStyle.Primary),
    );
  }

  const components = [row1];
  if (moonpayRow.components.length > 0) components.push(moonpayRow);

  return { embeds: [embed], components };
}

module.exports = { buildWalletView };

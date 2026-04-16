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
 */
function buildWalletView(wallet, user, lang) {
  const availableUsdc = (Number(wallet.balance_available) / USDC_PER_UNIT).toFixed(2);
  const heldUsdc = (Number(wallet.balance_held) / USDC_PER_UNIT).toFixed(2);
  const pendingUsdc = user && user.pending_balance ? (Number(user.pending_balance) / USDC_PER_UNIT).toFixed(2) : '0.00';

  const username = (user && (user.server_username || user.cod_ign)) || 'Player';

  const fields = [
    { name: t('wallet_embed.available', lang), value: `$${availableUsdc} USDC`, inline: true },
    { name: t('wallet_embed.held', lang), value: `$${heldUsdc} USDC`, inline: true },
  ];

  // Show pending balance field only when there are funds in dispute hold
  if (Number(pendingUsdc) > 0) {
    const releaseAt = user.pending_release_at ? new Date(user.pending_release_at) : null;
    const releaseText = releaseAt
      ? ` (available <t:${Math.floor(releaseAt.getTime() / 1000)}:R>)`
      : '';
    fields.push({
      name: t('wallet_embed.pending', lang),
      value: `$${pendingUsdc} USDC${releaseText}`,
      inline: true,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(t('wallet_embed.title', lang, { username }))
    .setColor(0x2ecc71)
    .setDescription(t('wallet.deposit_info', lang, { address: wallet.address }))
    .addFields(...fields)
    .setFooter({ text: t('wallet_embed.footer', lang) })
    .setTimestamp();

  // Language picker is in the welcome panel and dedicated language channel,
  // not here. The wallet panel still renders in the user's saved language.
  // Single "Withdraw" button — opens a choice screen where the user
  // picks between cashing out to fiat (Coinbase/Changelly offramp) or
  // sending USDC to any wallet address on Base. Keeps the wallet
  // surface clean and matches the deposit pattern (one click in).
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wallet_deposit').setLabel('💵 Deposit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('wallet_withdraw_menu').setLabel(t('wallet.btn_withdraw', lang)).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('wallet_refresh').setLabel('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('wallet_history').setLabel(t('wallet.btn_history', lang)).setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1] };
}

module.exports = { buildWalletView };

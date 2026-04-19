// Cash out to fiat — Coinbase offramp (Group A) or Changelly (Group B).
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const walletRepo = require('../../database/repositories/walletRepo');
const { USDC_PER_UNIT } = require('../../config/constants');
const changelly = require('../../services/changellyService');

/**
 * Show cash-out (fiat offramp) instructions based on deposit region.
 *
 * Group A gets a Coinbase offramp link. Group B gets Changelly sell.
 * Falls back to manual exchange instructions.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} user - DB user row.
 * @param {object} wallet - DB wallet row.
 * @param {string} lang - Locale code.
 */
async function handleCashOut(interaction, user, wallet, lang) {
  const depositRegion = user.deposit_region || 'GROUP_B';
  const address = wallet.address;

  if (depositRegion === 'GROUP_A' && process.env.CDP_PROJECT_ID) {
    const cdpAppId = process.env.CDP_PROJECT_ID;
    const offrampUrl = `https://pay.coinbase.com/sell/select-asset?appId=${cdpAppId}&addresses={"${address}":["base"]}&assets=["USDC"]`;

    const openButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setURL(offrampUrl).setLabel('Cash Out USDC').setStyle(ButtonStyle.Link),
    );

    return interaction.reply({
      content: [
        '**\u{1F4B8} Cash Out**',
        '',
        '1. Click the button below \u2014 it opens Coinbase',
        '2. Select how much USDC to sell',
        '3. Choose your payout method (bank, PayPal, etc.)',
        '4. Cash arrives in your account within minutes',
      ].join('\n'),
      components: [openButton],
      ephemeral: true,
    });
  }

  // Group B -- Changelly off-ramp
  if (changelly.isConfigured()) {
    try {
      await interaction.deferReply({ ephemeral: true });
      const availableUsdc = (Number(wallet.balance_available) / USDC_PER_UNIT).toFixed(2);
      const result = await changelly.createSellOrder({
        userId: user.discord_id,
        walletAddress: address,
        amountUsdc: availableUsdc,
        countryCode: user.country_code || 'US',
      });

      if (result?.redirectUrl) {
        const openButton = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setURL(result.redirectUrl).setLabel('Cash Out USDC').setStyle(ButtonStyle.Link),
        );

        return interaction.editReply({
          content: [
            '**\u{1F4B8} Cash Out**',
            '',
            '1. Click the button below',
            '2. Select how much USDC to sell',
            '3. Choose your payout method',
            '4. Cash arrives in your account',
          ].join('\n'),
          components: [openButton],
        });
      }
    } catch (err) {
      console.warn(`[Wallet] Changelly sell order failed: ${err.message}`);
    }
  }

  // Fallback -- manual instructions
  return interaction.reply({
    content: [
      '**\u{1F4B8} Cash Out**',
      '',
      'To convert your USDC to cash:',
      '1. Click **Send** to withdraw USDC to an exchange (Binance, Coinbase, etc.)',
      '2. Make sure to send to your exchange\'s **USDC deposit address on the Base network**',
      '3. Sell USDC for your local currency and withdraw to your bank',
    ].join('\n'),
    ephemeral: true,
  });
}

module.exports = { handleCashOut };

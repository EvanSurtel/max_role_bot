// Deposit info display — Coinbase Onramp (Group A) or Changelly (Group B).
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { t } = require('../../locales/i18n');
const changelly = require('../../services/changellyService');

/**
 * Show region-specific deposit instructions.
 *
 * Group A (US/UK/EU/etc.) gets a Coinbase Onramp link (0% fee).
 * Group B (everywhere else) gets a Changelly fiat on-ramp (~4-5% fee).
 * Falls back to generic manual instructions if no provider is configured.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} user - DB user row.
 * @param {object} wallet - DB wallet row.
 * @param {string} lang - Locale code.
 */
async function handleDeposit(interaction, user, wallet, lang) {
  const depositRegion = user.deposit_region || 'GROUP_B';
  const address = wallet.address;

  if (depositRegion === 'GROUP_A' && process.env.CDP_PROJECT_ID) {
    const cdpAppId = process.env.CDP_PROJECT_ID;
    const onrampUrl = `https://pay.coinbase.com/buy/select-asset?appId=${cdpAppId}&addresses={"${address}":["base"]}&assets=["USDC"]&presetFiatAmount=50&defaultPaymentMethod=CARD`;

    const openButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setURL(onrampUrl)
        .setLabel('Buy USDC')
        .setStyle(ButtonStyle.Link),
    );

    return interaction.reply({
      content: [
        '**\u{1F4B3} Deposit USDC**',
        '',
        `Your deposit address (Base network):`,
        `\`\`\`\n${address}\n\`\`\``,
        '',
        '**Steps:**',
        '1. Click the button below \u2014 it opens Coinbase',
        '2. Enter the amount you want (minimum $5)',
        '3. Pay with card, Apple Pay, Google Pay, or bank transfer',
        '4. USDC arrives in your wallet within a few minutes \u2014 **0% fee**',
        '',
        '\u26A0\uFE0F Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
      ].join('\n'),
      components: [openButton],
      ephemeral: true,
    });
  }

  // Group B (or no CDP key) -- Changelly fiat on-ramp
  if (changelly.isConfigured()) {
    try {
      await interaction.deferReply({ ephemeral: true });

      const order = await changelly.createOrder({
        userId: interaction.user.id,
        walletAddress: address,
        amountUsd: 50,
        countryCode: user.country_code || 'US',
      });

      if (order && order.redirectUrl) {
        const buyButton = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setURL(order.redirectUrl)
            .setLabel('Buy USDC')
            .setStyle(ButtonStyle.Link),
        );

        return interaction.editReply({
          content: [
            '**\u{1F4B3} Deposit USDC**',
            '',
            `Your deposit address (Base network):`,
            `\`\`\`\n${address}\n\`\`\``,
            '',
            '**Steps:**',
            '1. Click the button below \u2014 it opens the payment page',
            '2. Enter the amount you want (minimum ~$5)',
            '3. Pay with your card',
            '4. USDC arrives in your wallet within a few minutes',
            '',
            '\u{1F4B8} Fee: ~4-5% from the payment provider.',
            '',
            '\u26A0\uFE0F Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
          ].join('\n'),
          components: [buyButton],
        });
      }
    } catch (err) {
      console.error('[Wallet] Changelly order creation failed:', err);
    }

    // Changelly order failed -- show fallback with manual instructions
    return interaction.editReply({
      content: [
        '**\u{1F4B3} Deposit USDC**',
        '',
        `Your deposit address (Base network):`,
        `\`\`\`\n${address}\n\`\`\``,
        '',
        'We could not generate a payment link right now. You can still deposit by buying USDC on any exchange (Binance, Bybit, Coinbase, etc.) and sending it to your address above.',
        '',
        '\u26A0\uFE0F Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
      ].join('\n'),
    });
  }

  // Changelly not configured -- fallback manual instructions
  return interaction.reply({
    content: [
      '**\u{1F4B3} Deposit USDC**',
      '',
      `Your deposit address (Base network):`,
      `\`\`\`\n${address}\n\`\`\``,
      '',
      'Buy USDC on any exchange (Binance, Bybit, Coinbase, etc.) and send it to your address above.',
      '',
      '\u26A0\uFE0F Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
    ].join('\n'),
    ephemeral: true,
  });
}

module.exports = { handleDeposit };

// Deposit info display — Coinbase Onramp (Group A) or Changelly (Group B).
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { t } = require('../../locales/i18n');
const changelly = require('../../services/changellyService');
const onramp = require('../../services/coinbaseOnrampService');

// ISO 3166-1 alpha-2 → Onramp fiat currency. Coinbase's Onramp supports
// USD / CAD / GBP / EUR / AUD presets; anything else falls back to USD.
const FIAT_BY_COUNTRY = {
  CA: 'CAD', GB: 'GBP', AU: 'AUD',
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR',
  FR: 'EUR', GR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR', LV: 'EUR',
  MT: 'EUR', NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR',
};

/**
 * Show region-specific deposit instructions.
 *
 * Group A (US / UK / Canada / EU / etc.) — Coinbase Onramp one-click-buy:
 *   Calls POST /platform/v2/onramp/sessions to get a URL that, for users
 *   without an active Coinbase session, lands DIRECTLY on guest checkout
 *   (Apple Pay / debit card). No sign-in page.
 *
 * Group B (everywhere else) — Changelly fiat on-ramp:
 *   First pulls /offers to find an available provider (moonpay, banxa,
 *   transak, wert), then creates the order with that providerCode. The
 *   order's redirectUrl goes straight to the provider's hosted page —
 *   no Changelly account required.
 *
 * Manual fallback if either generator fails.
 */
async function handleDeposit(interaction, user, wallet, lang) {
  const depositRegion = user.deposit_region || 'GROUP_B';
  const address = wallet.address;
  const country = (user.country_code || '').toUpperCase();

  // ─── Group A: Coinbase one-click buy ────────────────────────
  if (depositRegion === 'GROUP_A' && onramp.isConfigured()) {
    await interaction.deferReply({ ephemeral: true });

    const paymentCurrency = FIAT_BY_COUNTRY[country] || 'USD';

    let onrampUrl;
    let quote = null;
    try {
      const session = await onramp.createOneClickBuySession({
        walletAddress: address,
        purchaseCurrency: 'USDC',
        destinationNetwork: 'base',
        paymentAmount: '50',
        paymentCurrency,
        // Intentionally omitting paymentMethod — letting Coinbase pick
        // the best available (including guest-eligible Apple Pay) for
        // the viewer. Pinning to CARD forces the Coinbase-account card
        // flow, which disqualifies the guest path.
        country: country || 'US',
        partnerUserRef: String(user.discord_id).slice(0, 49),
      });
      onrampUrl = session.onrampUrl;
      quote = session.quote;
    } catch (err) {
      console.error('[Wallet] Failed to create one-click Onramp session:', err.message);
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

    const openButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setURL(onrampUrl)
        .setLabel('Buy USDC')
        .setStyle(ButtonStyle.Link),
    );

    const quoteLine = quote?.paymentTotal
      ? `(Preview: **${quote.paymentTotal} ${quote.paymentCurrency}** → **${quote.purchaseAmount} USDC**)`
      : '';

    return interaction.editReply({
      content: [
        '**\u{1F4B3} Deposit USDC**',
        '',
        `Your deposit address (Base network):`,
        `\`\`\`\n${address}\n\`\`\``,
        '',
        '**Steps:**',
        '1. Click the button below \u2014 no Coinbase account needed',
        '2. Pay with **Apple Pay** or **debit card**',
        '3. USDC arrives in your wallet within a few minutes \u2014 **0% fee**',
        quoteLine ? '' : null,
        quoteLine || null,
        '',
        '\u26A0\uFE0F Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
      ].filter(line => line !== null).join('\n'),
      components: [openButton],
    });
  }

  // ─── Group B: Changelly ─────────────────────────────────────
  if (changelly.isConfigured()) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const order = await changelly.createOrder({
        userId: interaction.user.id,
        walletAddress: address,
        amountUsd: 50,
        countryCode: country || 'US',
      });

      if (order?.redirectUrl) {
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
            '1. Click the button below \u2014 no account needed',
            '2. Pay with your card on the payment page',
            '3. USDC arrives in your wallet within a few minutes',
            '',
            '\u{1F4B8} Fee: ~4\u20135% from the payment provider.',
            '',
            '\u26A0\uFE0F Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
          ].join('\n'),
          components: [buyButton],
        });
      }
    } catch (err) {
      console.error('[Wallet] Changelly order creation failed:', err.message);
    }

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

  // ─── No provider configured — manual only ───────────────────
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

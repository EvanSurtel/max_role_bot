// Deposit info display — multi-provider picker.
//
// The initial click on "Deposit USDC" in the wallet ephemeral shows the
// user ONE button per provider available for their country (via the
// paymentRouter). The user picks which provider they want; that click
// routes to a per-provider handler that actually mints the URL.
//
// Provider choices come from src/services/paymentRouter.js so the
// country → provider matrix and the CDP trial counter live in one place.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { t } = require('../../locales/i18n');
const changelly = require('../../services/changellyService');
const onramp = require('../../services/coinbaseOnrampService');
const paymentRouter = require('../../services/paymentRouter');

const DEFAULT_PRESET_USD = 50;

// ISO 3166-1 alpha-2 → Onramp fiat currency. Coinbase's Onramp supports
// USD / CAD / GBP / EUR / AUD presets; anything else falls back to USD.
const FIAT_BY_COUNTRY = {
  CA: 'CAD', GB: 'GBP', AU: 'AUD',
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR',
  FR: 'EUR', GR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR', LV: 'EUR',
  MT: 'EUR', NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR',
};

const STYLE_BY_INDEX = [ButtonStyle.Success, ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Secondary];

/**
 * Initial "Deposit USDC" click — show picker with one button per
 * available provider.
 */
async function handleDeposit(interaction, user, wallet, lang) {
  const country = (user.country_code || '').toUpperCase();
  const address = wallet.address;

  const options = paymentRouter.getOnrampOptions({ country, amountUsd: DEFAULT_PRESET_USD });

  if (options.length === 0) {
    return interaction.reply({
      content: [
        '**\u{1F4B3} Deposit USDC**',
        '',
        `Your deposit address (Base network):`,
        `\`\`\`\n${address}\n\`\`\``,
        '',
        'No card-payment providers are available for your region right now. You can still deposit by buying USDC on any exchange (Binance, Bybit, Coinbase, etc.) and sending it to your address above.',
        '',
        '\u26A0\uFE0F Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
      ].join('\n'),
      ephemeral: true,
    });
  }

  const buttons = options.slice(0, 5).map((opt, idx) =>
    new ButtonBuilder()
      .setCustomId(`wallet_deposit_${opt.provider}`)
      .setLabel(opt.label)
      .setStyle(opt.primary ? ButtonStyle.Success : STYLE_BY_INDEX[idx] || ButtonStyle.Secondary),
  );

  const descLines = options.map(o => `• **${o.label}** — ${o.description}`);

  return interaction.reply({
    content: [
      '**\u{1F4B3} Deposit USDC**',
      '',
      `Your deposit address (Base network):`,
      `\`\`\`\n${address}\n\`\`\``,
      '',
      '**Pick a payment method:**',
      ...descLines,
      '',
      '\u26A0\uFE0F Always send USDC on the **Base** network. Any other network will result in permanent loss of funds.',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(buttons)],
    ephemeral: true,
  });
}

/**
 * Route the per-provider follow-up click (wallet_deposit_cdp_onramp /
 * _wert / _transak) to the right order creator.
 */
async function handleDepositProvider(interaction, user, wallet, lang) {
  const id = interaction.customId;
  const country = (user.country_code || '').toUpperCase();

  if (id === 'wallet_deposit_cdp_onramp') {
    return _handleCdp(interaction, user, wallet, country);
  }
  if (id === 'wallet_deposit_wert') {
    return _handleChangelly(interaction, user, wallet, country, 'wert');
  }
  if (id === 'wallet_deposit_transak') {
    return _handleChangelly(interaction, user, wallet, country, 'transak');
  }

  return interaction.reply({ content: 'Unknown deposit provider.', ephemeral: true });
}

// ─── CDP Onramp (US-only on Day 1, guest checkout) ─────────────
async function _handleCdp(interaction, user, wallet, country) {
  if (!onramp.isConfigured()) {
    return interaction.reply({
      content: 'Coinbase Onramp is not configured. Please pick a different payment method.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const paymentCurrency = FIAT_BY_COUNTRY[country] || 'USD';

  let onrampUrl;
  let quote = null;
  try {
    const session = await onramp.createOneClickBuySession({
      walletAddress: wallet.address,
      purchaseCurrency: 'USDC',
      destinationNetwork: 'base',
      paymentAmount: String(DEFAULT_PRESET_USD),
      paymentCurrency,
      country: country || 'US',
      partnerUserRef: String(user.discord_id).slice(0, 49),
    });
    onrampUrl = session.onrampUrl;
    quote = session.quote;
  } catch (err) {
    console.error('[Wallet] Coinbase Onramp session failed:', err.message);
    return interaction.editReply({
      content: [
        '**\u{1F4B3} Deposit USDC — Coinbase**',
        '',
        'We couldn\'t generate a Coinbase payment link right now. Please pick another payment method from the previous menu, or deposit USDC directly to the Base address shown there.',
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
    ? `Preview: **${quote.paymentTotal} ${quote.paymentCurrency}** → **${quote.purchaseAmount} USDC**`
    : '';

  return interaction.editReply({
    content: [
      '**\u{1F4B3} Deposit USDC — Coinbase**',
      '',
      '1. Click **Buy USDC** below — no Coinbase account needed',
      '2. Pay with **Apple Pay** or **debit card**',
      '3. USDC arrives in your wallet within a few minutes',
      quoteLine ? '' : null,
      quoteLine || null,
    ].filter(l => l !== null).join('\n'),
    components: [openButton],
  });
}

// ─── Wert / Transak via Changelly ───────────────────────────────
async function _handleChangelly(interaction, user, wallet, country, preferredProviderCode) {
  if (!changelly.isConfigured()) {
    return interaction.reply({
      content: 'Changelly is not configured. Please pick a different payment method.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const order = await changelly.createOrder({
      userId: interaction.user.id,
      walletAddress: wallet.address,
      amountUsd: DEFAULT_PRESET_USD,
      countryCode: country || 'US',
      stateCode: user.state_code || null,
      preferredProviderCode,
    });

    if (order?.redirectUrl) {
      const buyButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setURL(order.redirectUrl)
          .setLabel('Buy USDC')
          .setStyle(ButtonStyle.Link),
      );

      const actualProvider = order.providerCode || preferredProviderCode;
      const providerLabel = actualProvider.charAt(0).toUpperCase() + actualProvider.slice(1);

      return interaction.editReply({
        content: [
          `**\u{1F4B3} Deposit USDC — ${providerLabel}**`,
          '',
          '1. Click **Buy USDC** below — goes straight to the payment page',
          '2. Pay with your card',
          '3. USDC arrives in your wallet within a few minutes',
          '',
          actualProvider !== preferredProviderCode
            ? `(${preferredProviderCode} wasn't available for your region — routed to ${actualProvider} instead.)`
            : null,
        ].filter(l => l !== null).join('\n'),
        components: [buyButton],
      });
    }
  } catch (err) {
    console.error(`[Wallet] Changelly order (${preferredProviderCode}) failed:`, err.message);
  }

  return interaction.editReply({
    content: [
      `**\u{1F4B3} Deposit USDC — ${preferredProviderCode}**`,
      '',
      `We couldn't generate a ${preferredProviderCode} payment link right now. Please pick another payment method or deposit USDC directly to your Base address.`,
    ].join('\n'),
  });
}

module.exports = { handleDeposit, handleDepositProvider };

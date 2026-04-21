// Cash out to fiat / gift cards — multi-provider picker.
//
// Initial click on "Cash Out" shows one button per provider available
// for the user's country (via paymentRouter). The user picks; that click
// routes to a per-provider handler that actually mints the URL.
//
// Day 1: Transak via Changelly is the primary fiat-bank route for most
// users. Bitrefill is always shown as a no-KYC alternative (gift cards
// instead of bank). CDP offramp is feature-flagged off until approval.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { USDC_PER_UNIT } = require('../../config/constants');
const changelly = require('../../services/changellyService');
const onramp = require('../../services/coinbaseOnrampService');
const bitrefill = require('../../services/bitrefillService');
const paymentRouter = require('../../services/paymentRouter');

const STYLE_BY_INDEX = [ButtonStyle.Success, ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Secondary];

/**
 * Initial "Cash Out" click — show picker with one button per available
 * provider.
 */
async function handleCashOut(interaction, user, wallet, lang) {
  const country = (user.country_code || '').toUpperCase();
  const availableUsdc = Number(wallet.balance_available) / USDC_PER_UNIT;

  const options = paymentRouter.getOfframpOptions({ country, amountUsdc: availableUsdc });

  if (options.length === 0) {
    return interaction.reply({
      content: [
        '**\u{1F4B8} Cash Out**',
        '',
        'No cash-out providers are available for your region right now. You can still withdraw USDC to your own exchange account (Binance, Coinbase, etc.) using the **Send** button and sell there.',
      ].join('\n'),
      ephemeral: true,
    });
  }

  const buttons = options.slice(0, 5).map((opt, idx) =>
    new ButtonBuilder()
      .setCustomId(`wallet_cashout_${opt.provider}`)
      .setLabel(opt.label)
      .setStyle(opt.primary ? ButtonStyle.Success : STYLE_BY_INDEX[idx] || ButtonStyle.Secondary),
  );

  const descLines = options.map(o => `• **${o.label}** — ${o.description}`);

  return interaction.reply({
    content: [
      '**\u{1F4B8} Cash Out**',
      '',
      `Available balance: **$${availableUsdc.toFixed(2)} USDC**`,
      '',
      '**Pick a cash-out method:**',
      ...descLines,
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(buttons)],
    ephemeral: true,
  });
}

/**
 * Route the per-provider follow-up click.
 */
async function handleCashOutProvider(interaction, user, wallet, lang) {
  const id = interaction.customId;
  const country = (user.country_code || '').toUpperCase();

  if (id === 'wallet_cashout_cdp_offramp') {
    return _handleCdpOfframp(interaction, user, wallet, country);
  }
  if (id === 'wallet_cashout_transak') {
    return _handleChangellySell(interaction, user, wallet, country, 'transak');
  }
  if (id === 'wallet_cashout_bitrefill') {
    return _handleBitrefill(interaction, user);
  }

  return interaction.reply({ content: 'Unknown cash-out provider.', ephemeral: true });
}

// ─── CDP Offramp — gated behind CDP_OFFRAMP_ENABLED ─────────────
async function _handleCdpOfframp(interaction, user, wallet, country) {
  if (!onramp.isConfigured()) {
    return interaction.reply({
      content: 'Coinbase cash-out is not configured. Pick a different option.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  let sessionToken;
  try {
    sessionToken = await onramp.createSessionToken({
      walletAddress: wallet.address,
      assets: ['USDC'],
      blockchains: ['base'],
    });
  } catch (err) {
    console.error('[Wallet] CDP Offramp session token failed:', err.message);
    return interaction.editReply({
      content: 'We couldn\'t generate a Coinbase cash-out link right now. Please pick a different option.',
    });
  }

  const params = new URLSearchParams({
    sessionToken,
    defaultAsset: 'USDC',
    defaultNetwork: 'base',
    partnerUserId: wallet.address.slice(0, 49),
  });
  const offrampUrl = `https://pay.coinbase.com/v3/sell/input?${params.toString()}`;

  const openButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setURL(offrampUrl).setLabel('Cash Out USDC').setStyle(ButtonStyle.Link),
  );

  return interaction.editReply({
    content: [
      '**\u{1F4B8} Cash Out — Coinbase**',
      '',
      '1. Click **Cash Out USDC** — opens Coinbase',
      '2. Sign into your Coinbase account (required for bank payouts)',
      '3. Select amount and payout method (bank, PayPal, etc.)',
      '4. Cash arrives in your account within minutes',
    ].join('\n'),
    components: [openButton],
  });
}

// ─── Transak via Changelly — primary bank cash-out on Day 1 ─────
async function _handleChangellySell(interaction, user, wallet, country, preferredProviderCode) {
  if (!changelly.isConfigured()) {
    return interaction.reply({
      content: 'Changelly is not configured. Pick a different option.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const availableUsdc = (Number(wallet.balance_available) / USDC_PER_UNIT).toFixed(2);

  try {
    const result = await changelly.createSellOrder({
      userId: user.discord_id,
      walletAddress: wallet.address,
      amountUsdc: availableUsdc,
      countryCode: country || 'US',
      stateCode: user.state_code || null,
      preferredProviderCode,
    });

    if (result?.redirectUrl) {
      const openButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setURL(result.redirectUrl).setLabel('Cash Out USDC').setStyle(ButtonStyle.Link),
      );

      const actualProvider = result.providerCode || preferredProviderCode;
      const providerLabel = actualProvider.charAt(0).toUpperCase() + actualProvider.slice(1);

      return interaction.editReply({
        content: [
          `**\u{1F4B8} Cash Out — ${providerLabel}**`,
          '',
          '1. Click **Cash Out USDC** — opens the payout page',
          '2. Complete ID verification (one-time, ~2–5 minutes)',
          '3. Select your bank / payout method',
          '4. We\'ll send your USDC on-chain once the provider confirms',
          '',
          actualProvider !== preferredProviderCode
            ? `(${preferredProviderCode} wasn't available — routed to ${actualProvider} instead.)`
            : null,
        ].filter(l => l !== null).join('\n'),
        components: [openButton],
      });
    }
  } catch (err) {
    console.warn(`[Wallet] Changelly sell order (${preferredProviderCode}) failed:`, err.message);
  }

  return interaction.editReply({
    content: `We couldn't generate a ${preferredProviderCode} cash-out link right now. Please pick a different option.`,
  });
}

// ─── Bitrefill — no-KYC gift card route, always available ───────
async function _handleBitrefill(interaction, user) {
  if (!bitrefill.isConfigured()) {
    // Link still works without the affiliate code — just without attribution.
    // We don't hard-block on it.
  }

  const url = bitrefill.buildAffiliateLink(user.discord_id);

  const openButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setURL(url).setLabel('Open Bitrefill').setStyle(ButtonStyle.Link),
  );

  return interaction.reply({
    content: [
      '**\u{1F4B8} Cash Out — Gift Cards (Bitrefill)**',
      '',
      '1. Click **Open Bitrefill** — goes straight to their site',
      '2. Pick the gift card brand you want (Amazon, Steam, Apple, Uber, 1,000+ others)',
      '3. Pay with your USDC on Base — no ID required up to ~$500/order',
      '4. Gift card code delivered by email instantly',
    ].join('\n'),
    components: [openButton],
    ephemeral: true,
  });
}

module.exports = { handleCashOut, handleCashOutProvider };

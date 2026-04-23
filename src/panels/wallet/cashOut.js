// Cash out flow:
//
//   Click "Cash Out"       → opens amount modal (pre-filled with their
//                            available USDC balance as a suggestion)
//   Submit amount modal    → shows provider picker with amount in button
//                            customIds (wallet_cashout_<provider>__<amount>)
//   Click provider button  → mints the URL for that provider / amount

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { USDC_PER_UNIT } = require('../../config/constants');
const changelly = require('../../services/changellyService');
const onramp = require('../../services/coinbaseOnrampService');
const bitrefill = require('../../services/bitrefillService');
const paymentRouter = require('../../services/paymentRouter');
const rateLimiter = require('../../utils/rateLimiter');
const { isDemoChannelContext } = require('../coinbaseReviewDemoPanel');

const MIN_CASHOUT_USDC = 5;
const STYLE_BY_INDEX = [ButtonStyle.Success, ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Secondary];

/**
 * Step 1 — user clicks "Cash Out". Open a modal asking how much USDC
 * to cash out. The user's available balance is shown in the label so
 * they know the upper bound.
 */
async function handleCashOut(interaction, user, wallet, lang) {
  const availableUsdc = Number(wallet.balance_available) / USDC_PER_UNIT;

  if (availableUsdc < MIN_CASHOUT_USDC) {
    return interaction.reply({
      content: `You need at least **$${MIN_CASHOUT_USDC} USDC** available to cash out. Current available: $${availableUsdc.toFixed(2)}.`,
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('wallet_cashout_amount_modal')
    .setTitle('Cash Out USDC');

  const amountInput = new TextInputBuilder()
    .setCustomId('cashout_amount_usdc')
    .setLabel(`How much USDC? (you have $${availableUsdc.toFixed(2)})`)
    .setPlaceholder(`e.g. ${availableUsdc.toFixed(2)}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(10);

  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));

  return interaction.showModal(modal);
}

/**
 * Step 2 — amount modal submitted. Validate, show provider picker with
 * amount encoded in each button's customId.
 */
async function handleCashOutAmountModal(interaction, user, wallet, lang) {
  const raw = interaction.fields.getTextInputValue('cashout_amount_usdc').trim();
  const amount = Number(raw.replace(/[^0-9.]/g, ''));
  const availableUsdc = Number(wallet.balance_available) / USDC_PER_UNIT;

  if (!Number.isFinite(amount) || amount < MIN_CASHOUT_USDC) {
    return interaction.reply({
      content: `Invalid amount. Enter a USDC number of at least ${MIN_CASHOUT_USDC}.`,
      ephemeral: true,
    });
  }
  if (amount > availableUsdc) {
    return interaction.reply({
      content: `You only have **$${availableUsdc.toFixed(2)} USDC** available. Enter a smaller amount.`,
      ephemeral: true,
    });
  }
  const amountUsdc = Math.round(amount * 100) / 100;

  // Demo channel override — Coinbase reviewers need to see the CDP
  // offramp regardless of where they're registered AND regardless of
  // the CDP_OFFRAMP_ENABLED feature flag. Force US + pass demo=true
  // to include the CDP option unconditionally for reviewers.
  const demo = isDemoChannelContext(interaction);
  const country = demo ? 'US' : (user.country_code || '').toUpperCase();

  const options = paymentRouter.getOfframpOptions({ country, amountUsdc, demo });

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

  const amountStr = String(amountUsdc);
  const buttons = options.slice(0, 5).map((opt, idx) =>
    new ButtonBuilder()
      .setCustomId(`wallet_cashout_${opt.provider}__${amountStr}`)
      .setLabel(opt.label)
      .setStyle(opt.primary ? ButtonStyle.Success : STYLE_BY_INDEX[idx] || ButtonStyle.Secondary),
  );

  const descLines = options.map(o => `• **${o.label}** — ${o.description}`);

  return interaction.reply({
    content: [
      `**\u{1F4B8} Cash Out $${amountUsdc.toFixed(2)} USDC**`,
      '',
      '**Pick a cash-out method:**',
      ...descLines,
      '',
      '_Rank $ does not charge any cash-out fee. All fees shown go to the cash-out provider (Coinbase / Transak / Bitrefill), not to us._',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(buttons)],
    ephemeral: true,
  });
}

/**
 * Step 3 — provider button clicked. Parse provider + amount from the
 * customId.
 */
async function handleCashOutProvider(interaction, user, wallet, lang) {
  const id = interaction.customId;
  // Same demo-channel override as the amount modal — keep the
  // provider branch consistent with the picker and let the CDP
  // offramp session mint for a non-US reviewer.
  const country = isDemoChannelContext(interaction)
    ? 'US'
    : (user.country_code || '').toUpperCase();

  const rest = id.slice('wallet_cashout_'.length);
  const [providerKey, amountStr] = rest.split('__');
  const amountUsdc = Number(amountStr);

  // Re-validate against current balance. The customId is user-
  // controllable (modified Discord client) so we can't trust the
  // amount that comes out of it.
  const availableUsdc = Number(wallet.balance_available) / USDC_PER_UNIT;
  if (!Number.isFinite(amountUsdc) || amountUsdc < MIN_CASHOUT_USDC) {
    return interaction.reply({
      content: `Invalid amount. Must be at least $${MIN_CASHOUT_USDC} USDC.`,
      ephemeral: true,
    });
  }
  if (amountUsdc > availableUsdc) {
    return interaction.reply({
      content: `You only have $${availableUsdc.toFixed(2)} USDC available; can't cash out $${amountUsdc.toFixed(2)}.`,
      ephemeral: true,
    });
  }

  // Rate limit cash-outs under the same 24h quota as withdrawals —
  // both are money-moving actions. Prevents a user from bypassing the
  // withdraw quota by pivoting to the cashout flow. Bitrefill is
  // affiliate-link only (no backend action), so it's excluded.
  //
  // Record quota ATTEMPT-wise, not success-wise: if we only record on
  // provider-link success, a user hitting provider errors (region not
  // supported, Changelly rate-limited, CDP session expired) could
  // retry indefinitely. Recording on attempt treats cashout symmetrically
  // with withdraw and closes the spam loophole.
  if (providerKey !== 'bitrefill') {
    const quota = rateLimiter.checkQuota(String(user.discord_id), 'WITHDRAW_PER_24H');
    if (quota.blocked) {
      return interaction.reply({
        content: `You've used all ${quota.max} cash-outs / withdrawals for the day. Try again in ~${Math.ceil(quota.remainingSeconds / 3600)}h.`,
        ephemeral: true,
      });
    }
    rateLimiter.recordQuota(String(user.discord_id), 'WITHDRAW_PER_24H');
  }

  if (providerKey === 'cdp_offramp') {
    return _handleCdpOfframp(interaction, user, wallet, country, amountUsdc);
  }
  if (providerKey === 'transak') {
    return _handleChangellySell(interaction, user, wallet, country, 'transak', amountUsdc);
  }
  if (providerKey === 'bitrefill') {
    return _handleBitrefill(interaction, user, amountUsdc);
  }

  return interaction.reply({ content: 'Unknown cash-out provider.', ephemeral: true });
}

// ─── CDP Offramp — gated behind CDP_OFFRAMP_ENABLED ─────────────
//
// Same reason as deposit._handleCdp: CDP requires clientIp on the
// session-token POST, and Discord interactions don't carry a real user
// IP. We mint a one-time link nonce with the cash-out context, DM/reply
// a link to the wallet web surface, and let the web page call the bot
// with the real x-forwarded-for IP. The bot then mints the CDP session
// token with clientIp attached and returns the offramp URL.
async function _handleCdpOfframp(interaction, user, wallet, country, amountUsdc) {
  if (!onramp.isConfigured()) {
    return interaction.reply({
      content: 'Coinbase cash-out is not configured. Pick a different option.',
      ephemeral: true,
    });
  }
  if (!process.env.WALLET_WEB_BASE_URL) {
    return interaction.reply({
      content: 'Coinbase cash-out routing is not configured (web surface URL missing). Pick a different option.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  let url;
  try {
    const linkNonceService = require('../../services/linkNonceService');
    url = linkNonceService.mintLink({
      userId: user.id,
      purpose: 'cashout-cdp',
      ttlSeconds: 600,
      metadata: {
        walletAddress: wallet.address,
        amountUsdc,
      },
    });
  } catch (err) {
    console.error('[Wallet] Coinbase Offramp link mint failed:', err.message);
    return interaction.editReply({
      content: 'We couldn\'t prepare your Coinbase cash-out link right now. Please pick a different option.',
    });
  }

  const openButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setURL(url).setLabel('Continue to Coinbase').setStyle(ButtonStyle.Link),
  );

  return interaction.editReply({
    content: [
      `**\u{1F4B8} Cash Out $${amountUsdc} USDC — Coinbase**`,
      '',
      '1. Click **Continue to Coinbase** below — opens a one-time secure page on Rank $',
      '2. That page hands off to the Coinbase cash-out widget',
      '3. Sign into your Coinbase account (required for bank payouts)',
      '4. Confirm the amount and payout method (bank, PayPal, etc.)',
      '5. Cash arrives in your account within minutes',
      '',
      '_The link expires in 10 minutes. Single use._',
    ].join('\n'),
    components: [openButton],
  });
}

// ─── Transak via Changelly — primary bank cash-out on Day 1 ─────
async function _handleChangellySell(interaction, user, wallet, country, preferredProviderCode, amountUsdc) {
  if (!changelly.isConfigured()) {
    return interaction.reply({
      content: 'Changelly is not configured. Pick a different option.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await changelly.createSellOrder({
      userId: user.discord_id,
      walletAddress: wallet.address,
      amountUsdc: amountUsdc.toFixed(2),
      countryCode: country || 'US',
      stateCode: user.state_code || null,
      preferredProviderCode,
    });

    if (result?.redirectUrl) {
      // Quota already recorded at the top of handleCashOutProvider.
      const openButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setURL(result.redirectUrl).setLabel('Cash Out USDC').setStyle(ButtonStyle.Link),
      );

      const actualProvider = result.providerCode || preferredProviderCode;
      const providerLabel = actualProvider.charAt(0).toUpperCase() + actualProvider.slice(1);

      return interaction.editReply({
        content: [
          `**\u{1F4B8} Cash Out $${amountUsdc} USDC — ${providerLabel}**`,
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
async function _handleBitrefill(interaction, user, amountUsdc) {
  const url = bitrefill.buildAffiliateLink(user.discord_id);

  const openButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setURL(url).setLabel('Open Bitrefill').setStyle(ButtonStyle.Link),
  );

  return interaction.reply({
    content: [
      `**\u{1F4B8} Cash Out $${amountUsdc} USDC — Gift Cards (Bitrefill)**`,
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

module.exports = {
  handleCashOut,
  handleCashOutAmountModal,
  handleCashOutProvider,
};

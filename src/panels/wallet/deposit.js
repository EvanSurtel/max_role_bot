// Deposit flow:
//
//   Click "Deposit USDC"   → opens amount modal
//   Submit amount modal    → shows provider picker with amount in the
//                            button customIds (wallet_deposit_<provider>_<amount>)
//   Click provider button  → mints the URL for that provider at that amount
//
// Provider choices come from src/services/paymentRouter.js so the
// country → provider matrix, CDP trial counter, and Wert lifetime KYC
// state all live in one place.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const changelly = require('../../services/changellyService');
const onramp = require('../../services/coinbaseOnrampService');
const paymentRouter = require('../../services/paymentRouter');

const MIN_DEPOSIT_USD = 5;
const MAX_DEPOSIT_USD = 1000;
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
 * Step 1 — user clicks "Deposit USDC". Open a modal asking for the
 * USD amount they want to deposit.
 */
async function handleDeposit(interaction, user, wallet, lang) {
  const modal = new ModalBuilder()
    .setCustomId('wallet_deposit_amount_modal')
    .setTitle('Deposit USDC');

  const amountInput = new TextInputBuilder()
    .setCustomId('deposit_amount_usd')
    .setLabel(`How much USD? (min $${MIN_DEPOSIT_USD}, max $${MAX_DEPOSIT_USD})`)
    .setPlaceholder(`e.g. ${DEFAULT_PRESET_USD}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(6);

  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));

  return interaction.showModal(modal);
}

/**
 * Step 2 — amount modal submitted. Validate the amount and show the
 * provider picker with amount encoded in each button customId.
 */
async function handleDepositAmountModal(interaction, user, wallet, lang) {
  const raw = interaction.fields.getTextInputValue('deposit_amount_usd').trim();
  const amount = Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_USD || amount > MAX_DEPOSIT_USD) {
    return interaction.reply({
      content: `Invalid amount. Enter a USD number between $${MIN_DEPOSIT_USD} and $${MAX_DEPOSIT_USD}.`,
      ephemeral: true,
    });
  }
  const amountUsd = Math.round(amount * 100) / 100; // 2-decimal round

  const country = (user.country_code || '').toUpperCase();
  const address = wallet.address;

  const options = paymentRouter.getOnrampOptions({ country, amountUsd, userId: user.id });

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
        '\u26A0\uFE0F Make sure to send USDC on the **Base** network.',
      ].join('\n'),
      ephemeral: true,
    });
  }

  // Encode amount in button customId so the per-provider handler can
  // read it without needing separate state storage.
  const amountStr = String(amountUsd);
  const buttons = options.slice(0, 5).map((opt, idx) =>
    new ButtonBuilder()
      .setCustomId(`wallet_deposit_${opt.provider}__${amountStr}`)
      .setLabel(opt.label)
      .setStyle(opt.primary ? ButtonStyle.Success : STYLE_BY_INDEX[idx] || ButtonStyle.Secondary),
  );

  const descLines = options.map(o => `• **${o.label}** — ${o.description}`);

  return interaction.reply({
    content: [
      `**\u{1F4B3} Deposit $${amountUsd.toFixed(2)} USDC**`,
      '',
      `Your deposit address (Base network):`,
      `\`\`\`\n${address}\n\`\`\``,
      '',
      '**Pick a payment method:**',
      ...descLines,
      '',
      '_Rank $ does not charge any deposit fee. All fees shown go to the payment provider (Coinbase / Wert / Transak), not to us._',
      '',
      '\u26A0\uFE0F Always send USDC on the **Base** network. Any other network will result in permanent loss of funds.',
    ].join('\n'),
    components: [new ActionRowBuilder().addComponents(buttons)],
    ephemeral: true,
  });
}

/**
 * Step 3 — provider button clicked. Parse provider + amount from
 * customId (format: wallet_deposit_<provider>__<amount>, where
 * <provider> can itself contain one underscore — e.g. cdp_onramp).
 */
async function handleDepositProvider(interaction, user, wallet, lang) {
  const id = interaction.customId;
  const country = (user.country_code || '').toUpperCase();

  const rest = id.slice('wallet_deposit_'.length);
  const [providerKey, amountStr] = rest.split('__');
  const amountUsd = Number(amountStr);

  // Re-validate — the customId is user-controllable (they can edit it
  // in a modified Discord client). Modal validation at input time
  // isn't enough; the handler is the trust boundary.
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_DEPOSIT_USD || amountUsd > MAX_DEPOSIT_USD) {
    return interaction.reply({
      content: `Invalid amount. Enter a USD amount between $${MIN_DEPOSIT_USD} and $${MAX_DEPOSIT_USD}.`,
      ephemeral: true,
    });
  }

  if (providerKey === 'cdp_onramp') {
    return _handleCdp(interaction, user, wallet, country, amountUsd);
  }
  if (providerKey === 'wert') {
    return _handleChangelly(interaction, user, wallet, country, 'wert', amountUsd);
  }
  if (providerKey === 'transak') {
    return _handleChangelly(interaction, user, wallet, country, 'transak', amountUsd);
  }

  return interaction.reply({ content: 'Unknown deposit provider.', ephemeral: true });
}

// ─── CDP Onramp (US-only on Day 1, guest checkout) ─────────────
async function _handleCdp(interaction, user, wallet, country, amountUsd) {
  if (!onramp.isConfigured()) {
    return interaction.reply({
      content: 'Coinbase Onramp is not configured. Please pick a different payment method.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // Defensive: if the picker still somehow offered CDP for an amount
  // above the trial per-tx cap (shouldn't happen — router hides CDP
  // for amounts > cap), clamp here too so we don't 4xx Coinbase.
  const cdpTrial = require('../../services/cdpTrialService');
  const perTxMax = cdpTrial.getMaxPerTxUsd();
  if (amountUsd > perTxMax) {
    console.warn(`[Wallet] CDP request $${amountUsd} over per-tx cap $${perTxMax}; clamping.`);
    amountUsd = perTxMax;
  }

  const paymentCurrency = FIAT_BY_COUNTRY[country] || 'USD';

  let onrampUrl;
  let quote = null;
  try {
    const session = await onramp.createOneClickBuySession({
      walletAddress: wallet.address,
      purchaseCurrency: 'USDC',
      destinationNetwork: 'base',
      paymentAmount: String(amountUsd),
      paymentCurrency,
      country: country || 'US',
      partnerUserRef: String(user.discord_id).slice(0, 49),
    });
    onrampUrl = session.onrampUrl;
    quote = session.quote;
  } catch (err) {
    // Trial-cap error → silently fall back to Wert. forceExhaust fired
    // inside coinbaseOnrampService so future pickers won't offer CDP
    // until the counter resets.
    if (err instanceof onramp.TrialExhaustedError) {
      console.warn(`[Wallet] CDP trial exhausted for ${user.discord_id} @ $${amountUsd}; silently falling back to Wert.`);
      // Ops visibility — logged to the cash-tx feed so admins can see
      // how often the silent fallback fires without leaking it to the
      // user.
      try {
        const { postTransaction } = require('../../utils/transactionFeed');
        postTransaction({
          type: 'cdp_fallback_to_wert',
          discordId: String(user.discord_id),
          memo: `CDP trial exhausted mid-request ($${amountUsd}) — silently routed to Wert`,
        });
      } catch { /* best effort */ }
      return _handleChangelly(interaction, user, wallet, country, 'wert', amountUsd, {
        alreadyDeferred: true,
        fallbackFromCdp: true,
      });
    }
    console.error('[Wallet] Coinbase Onramp session failed:', err.message);
    return interaction.editReply({
      content: [
        '**\u{1F4B3} Deposit USDC — Coinbase**',
        '',
        'We couldn\'t generate a Coinbase payment link right now. Please pick another payment method or deposit USDC directly to the Base address shown earlier.',
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
      `**\u{1F4B3} Deposit $${amountUsd} USDC — Coinbase**`,
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
async function _handleChangelly(interaction, user, wallet, country, preferredProviderCode, amountUsd, opts = {}) {
  // Changelly requires state for US; existing users who onboarded
  // before the state_code migration have NULL. Prompt them to enter
  // it in-line rather than letting the /orders call silently fail.
  if (country === 'US' && !user.state_code) {
    const { ModalBuilder: MB, TextInputBuilder: TI, TextInputStyle: TIS, ActionRowBuilder: AR } = require('discord.js');
    const modal = new MB()
      .setCustomId('wallet_deposit_state_modal')
      .setTitle('US State Required');
    const input = new TI()
      .setCustomId('deposit_state_code')
      .setLabel('Your US state (2-letter code, e.g. NY, CA, TX)')
      .setStyle(TIS.Short)
      .setRequired(true)
      .setMinLength(2)
      .setMaxLength(2);
    modal.addComponents(new AR().addComponents(input));
    return interaction.showModal(modal);
  }

  // Wert LKYC cap guard — stop rapid-fire deposits from exceeding
  // $1000 lifetime before their webhooks land. Sums the in-flight
  // (paymentEventRepo credited rows), plus any new amount now, and
  // refuses if it would blow through.
  if (preferredProviderCode === 'wert') {
    try {
      const wertKyc = require('../../database/repositories/wertKycRepo');
      const projected = wertKyc.getLifetimeUsd(user.id) + amountUsd;
      if (projected > wertKyc.LKYC_CAP_USD) {
        const msg = `This $${amountUsd} Wert deposit would push your lifetime Wert total past the $${wertKyc.LKYC_CAP_USD} no-ID cap (you're at $${wertKyc.getLifetimeUsd(user.id).toFixed(2)}). Please pick **Transak** instead — it needs ID once but has no lifetime cap.`;
        if (opts.alreadyDeferred) {
          return interaction.editReply({ content: msg });
        }
        return interaction.reply({ content: msg, ephemeral: true });
      }
    } catch { /* best effort — don't block the deposit if the check itself fails */ }
  }

  if (!changelly.isConfigured()) {
    if (opts.alreadyDeferred) {
      return interaction.editReply({
        content: 'Changelly is not configured. Please deposit USDC directly to your Base address.',
      });
    }
    return interaction.reply({
      content: 'Changelly is not configured. Please pick a different payment method.',
      ephemeral: true,
    });
  }

  if (!opts.alreadyDeferred) {
    await interaction.deferReply({ ephemeral: true });
  }

  try {
    const order = await changelly.createOrder({
      userId: interaction.user.id,
      walletAddress: wallet.address,
      amountUsd,
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

      // Silent CDP → Wert fallback: user sees the Wert result exactly
      // as if they had picked Wert in the first place. No "Apple Pay
      // unavailable" breadcrumb — the CDP trial cap is an operational
      // detail, not a user concern.
      return interaction.editReply({
        content: [
          `**\u{1F4B3} Deposit $${amountUsd} USDC — ${providerLabel}**`,
          '',
          '1. Click **Buy USDC** below — goes straight to the payment page',
          '2. Pay with your card',
          '3. USDC arrives in your wallet within a few minutes',
          '',
          (!opts.fallbackFromCdp && actualProvider !== preferredProviderCode)
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

module.exports = { handleDeposit, handleDepositAmountModal, handleDepositProvider };

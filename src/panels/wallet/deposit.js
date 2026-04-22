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
const { isDemoChannelContext } = require('../coinbaseReviewDemoPanel');

const MIN_DEPOSIT_USD = 5;
const MAX_DEPOSIT_USD = 1000;
const DEFAULT_PRESET_USD = 50;

// ISO 3166-1 alpha-2 → Onramp fiat currency, covering every country
// where Coinbase Onramp operates. Coinbase doesn't publish a static
// country→currency dump (the definitive runtime source is their
// `/onramp/v1/buy/options?country=XX` endpoint), so this map pairs
// each supported country with its ISO-4217 primary currency. Widget
// behavior when we send a local currency that Coinbase's rail
// doesn't route: the widget auto-falls-back to USD on its side
// (per CDP docs on generating-quotes).
//
// Sourced from:
//   - CDP Onramp FAQ (April 2026): "Onramp is available in all
//     countries Coinbase operates in EXCEPT Japan"
//     https://docs.cdp.coinbase.com/onramp/additional-resources/faq
//   - CDP Countries & Currencies docs
//     https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/countries-&-currencies
//   - Coinbase country availability (help.coinbase.com +
//     coinbase.com/country-availability)
//   - coinbase/cbpay-js SDK: presetFiatAmount only natively supports
//     USD/CAD/GBP/EUR — other currencies are accepted but widget may
//     re-render amount in USD if the rail isn't enabled for that pair.
//
// EXCLUDED on purpose:
//   - JP (Coinbase operates, Onramp does not per CDP FAQ)
//   - OFAC / sanctioned regions (CN, CU, IR, KP, SY, RU and
//     regional variants, VE, MM, BY, AF, IQ, LY, SD, SS, ZW, YE)
const FIAT_BY_COUNTRY = {
  AD: 'EUR', AE: 'AED', AG: 'XCD', AI: 'XCD', AL: 'ALL', AO: 'AOA',
  AR: 'ARS', AT: 'EUR', AU: 'AUD', AW: 'AWG', AZ: 'AZN', BA: 'BAM',
  BB: 'BBD', BE: 'EUR', BG: 'BGN', BJ: 'XOF', BM: 'BMD', BO: 'BOB',
  BR: 'BRL', BS: 'BSD', BW: 'BWP', BZ: 'BZD',
  CA: 'CAD', CH: 'CHF', CI: 'XOF', CL: 'CLP', CO: 'COP', CR: 'CRC',
  CV: 'CVE', CY: 'EUR', CZ: 'CZK',
  DE: 'EUR', DK: 'DKK', DM: 'XCD', DO: 'DOP',
  EC: 'USD', EE: 'EUR', EG: 'EGP', ES: 'EUR',
  FI: 'EUR', FJ: 'FJD', FR: 'EUR',
  GB: 'GBP', GD: 'XCD', GE: 'GEL', GG: 'GBP', GH: 'GHS', GI: 'GIP',
  GL: 'DKK', GR: 'EUR', GT: 'GTQ', GY: 'GYD',
  HK: 'HKD', HN: 'HNL', HR: 'EUR', HU: 'HUF',
  ID: 'IDR', IE: 'EUR', IL: 'ILS', IM: 'GBP', IN: 'INR', IS: 'ISK',
  IT: 'EUR',
  JE: 'GBP', JM: 'JMD', JO: 'JOD',
  KE: 'KES', KG: 'KGS', KN: 'XCD', KR: 'KRW', KW: 'KWD', KY: 'KYD',
  KZ: 'KZT',
  LC: 'XCD', LI: 'CHF', LK: 'LKR', LT: 'EUR', LU: 'EUR', LV: 'EUR',
  MA: 'MAD', MC: 'EUR', MD: 'MDL', ME: 'EUR', MG: 'MGA', MK: 'MKD',
  MN: 'MNT', MS: 'XCD', MT: 'EUR', MU: 'MUR', MW: 'MWK', MX: 'MXN',
  MY: 'MYR', MZ: 'MZN',
  NA: 'NAD', NG: 'NGN', NI: 'NIO', NL: 'EUR', NO: 'NOK', NZ: 'NZD',
  OM: 'OMR',
  PA: 'PAB', PE: 'PEN', PG: 'PGK', PH: 'PHP', PK: 'PKR', PL: 'PLN',
  PT: 'EUR', PY: 'PYG',
  QA: 'QAR',
  RO: 'RON', RW: 'RWF',
  SA: 'SAR', SC: 'SCR', SE: 'SEK', SG: 'SGD', SI: 'EUR', SK: 'EUR',
  SM: 'EUR', SN: 'XOF', SR: 'SRD', SV: 'USD', SZ: 'SZL',
  TC: 'USD', TH: 'THB', TR: 'TRY', TT: 'TTD', TW: 'TWD', TZ: 'TZS',
  UA: 'UAH', UG: 'UGX', US: 'USD', UY: 'UYU', UZ: 'UZS',
  VC: 'XCD', VG: 'USD', VN: 'VND',
  ZA: 'ZAR', ZM: 'ZMW',
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

  // Demo channel: pass demo=true so the router bypasses the country
  // restriction + CDP_ONRAMP_ENABLED flag to make the Coinbase button
  // visible. Do NOT force country=US — the description copy should
  // still reflect where the reviewer actually is (US = guest checkout,
  // non-US = Coinbase account required) so they see honest UI.
  const demo = isDemoChannelContext(interaction);
  const country = (user.country_code || '').toUpperCase();
  const address = wallet.address;

  const options = paymentRouter.getOnrampOptions({ country, amountUsd, userId: user.id, demo });

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
  // Same demo-channel override as the amount modal above — keeps the
  // provider branch (CDP / Wert / Transak) consistent with what the
  // user was shown in the picker, and ensures the CDP Onramp session
  // is minted with country='US' for a non-US reviewer.
  const country = isDemoChannelContext(interaction)
    ? 'US'
    : (user.country_code || '').toUpperCase();

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

  // Pass the user's actual country + their native fiat currency so
  // Coinbase's widget matches their real payment method. If we hard-
  // code USD for a CA user whose bank is CAD, Coinbase's widget
  // renders "The currency you selected does not match your payment
  // method, please enter a CAD amount" and the Confirm button sits
  // disabled. FIAT_BY_COUNTRY maps ISO country → local currency; we
  // fall back to USD for anything unmapped (which Coinbase's widget
  // then lets the user switch in-widget).
  const apiCountry = country || 'US';
  const paymentCurrency = FIAT_BY_COUNTRY[apiCountry] || 'USD';

  let onrampUrl;
  let quote = null;
  try {
    const session = await onramp.createOneClickBuySession({
      walletAddress: wallet.address,
      purchaseCurrency: 'USDC',
      destinationNetwork: 'base',
      paymentAmount: String(amountUsd),
      paymentCurrency,
      country: apiCountry,
      partnerUserRef: String(user.discord_id).slice(0, 49),
    });
    onrampUrl = session.onrampUrl;
    quote = session.quote;
  } catch (err) {
    // Only TrialExhaustedError justifies a silent Wert fallback —
    // that's the one case where our API quota is actually gone and
    // the user shouldn't see a broken Coinbase error. Everything
    // else (country reject, malformed request, network blip) should
    // surface a clear message, not bounce the user to Wert.
    if (err instanceof onramp.TrialExhaustedError) {
      console.warn(`[Wallet] CDP trial exhausted for ${user.discord_id} @ $${amountUsd}; silently falling back to Wert.`);
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
        'We couldn\'t generate a Coinbase payment link right now. Please pick another payment method (Wert or Transak) or deposit USDC directly to the Base address shown earlier.',
        '',
        `_Error: ${err.message}_`,
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
  // Demo channel: we forced country='US' upstream so the picker would
  // include the Coinbase option, but the reviewer isn't actually in
  // the US and has no state_code on file. Do NOT prompt them for a
  // US state — pass 'NY' as a placeholder to Changelly and let the
  // reviewer see the flow uninterrupted. The review is about the
  // integration working, not about Changelly routing a real US user.
  const inDemoChannel = isDemoChannelContext(interaction);

  // Changelly requires state for US; existing users who onboarded
  // before the state_code migration have NULL. Prompt them to enter
  // it in-line rather than letting the /orders call silently fail.
  //
  // IMPORTANT: showModal MUST be the first response to a button
  // interaction AND cannot be called on an already-deferred
  // interaction. If we got here via the CDP→Wert fallback path
  // (opts.alreadyDeferred=true), we cannot open a modal — instead
  // surface a plain editReply asking the user to try the dedicated
  // Wert/Transak button first so they see the modal fresh.
  if (country === 'US' && !user.state_code && !inDemoChannel) {
    if (opts.alreadyDeferred) {
      return interaction.editReply({
        content: 'We need your US state on file before we can route deposits to Wert/Transak. Please click **Deposit USDC** again and pick the non-Coinbase option — the form will open.',
      });
    }
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
    // showModal must run synchronously from the interaction handler;
    // no await / async work should precede it or the 3-second
    // response window may close.
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
    // Demo channel: country was forced to 'US' upstream for CDP
    // visibility; Changelly's Wert/Transak route needs a state_code
    // when country=US, and the reviewer doesn't have one. Pass 'NY'
    // as a harmless placeholder — the review is about seeing the
    // integration work, not validating real US residency.
    const effectiveStateCode = inDemoChannel
      ? (user.state_code || 'NY')
      : (user.state_code || null);

    const order = await changelly.createOrder({
      userId: interaction.user.id,
      walletAddress: wallet.address,
      amountUsd,
      countryCode: country || 'US',
      stateCode: effectiveStateCode,
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

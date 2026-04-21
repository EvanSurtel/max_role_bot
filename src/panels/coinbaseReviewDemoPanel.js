// Coinbase CDP review-demo channel.
//
// Public Discord channel (configurable via DEMO_CHANNEL_ID) with a
// single pinned bot-posted message + a "Launch Onramp Demo" button.
// Clicking the button mints a one-click CDP Onramp session (via the
// exact same coinbaseOnrampService.createOneClickBuySession path that
// production uses) against a throwaway Base address (DEMO_WALLET_ADDRESS),
// with partnerUserRef prefixed `cdp-review-demo-<discordId>` so we can
// tell reviewer activity apart from real users in payment_events.
//
// Reviewer access: user configures channel permissions so @everyone can
// View + Read (no Send), then sends the Coinbase reviewer a server
// invite. Reviewer joins, clicks the button, sees the live Onramp URL
// open into Coinbase's guest-checkout flow.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const onramp = require('../services/coinbaseOnrampService');
const cdpTrial = require('../services/cdpTrialService');

const DEMO_TITLE = 'Coinbase Onramp Integration Demo';
const DEMO_CUSTOM_ID = 'coinbase_review_demo';
const DEMO_PRESET_USD = 5;

/**
 * Post or refresh the demo message in DEMO_CHANNEL_ID. Called from
 * bot startup. If a demo message with the expected title already
 * exists in the channel, we edit it in place (CLAUDE.md convention);
 * otherwise we post a fresh one.
 */
async function postCoinbaseReviewDemoPanel(client, lang = 'en') {
  const channelId = process.env.DEMO_CHANNEL_ID;
  if (!channelId) {
    console.log('[DemoPanel] DEMO_CHANNEL_ID not set — skipping Coinbase review demo panel');
    return;
  }

  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    try { channel = await client.channels.fetch(channelId); } catch {
      console.error(`[DemoPanel] Could not fetch channel ${channelId}`);
      return;
    }
  }
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(DEMO_TITLE)
    .setColor(0x0052FF)
    .setDescription([
      'This channel demonstrates Rank $\'s Coinbase CDP Onramp integration for the CDP review team.',
      '',
      'Click **Launch Onramp Demo** below to spin up a live one-click-buy session — the same code path our production `/deposit` flow uses.',
      '',
      `**Preset amount:** $${DEMO_PRESET_USD} USD`,
      '**Asset:** USDC',
      '**Network:** Base',
      '**Payment:** Apple Pay / debit card (Guest Checkout — US today)',
      '',
      'Response is **ephemeral** (only the clicker sees the URL), so the channel stays clean for other reviewers. The Onramp URL itself is a single-use, 5-minute-TTL session token.',
    ].join('\n'))
    .setFooter({ text: 'Rank $ × Coinbase Developer Platform' });

  const button = new ButtonBuilder()
    .setCustomId(DEMO_CUSTOM_ID)
    .setLabel('Launch Onramp Demo')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('🚀');

  const components = [new ActionRowBuilder().addComponents(button)];

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const existing = messages.find(m =>
      m.author.id === client.user.id &&
      m.embeds.some(e => e.title === DEMO_TITLE),
    );
    if (existing) {
      // Clean up any stray bot messages so the demo panel stays the
      // only thing in the channel.
      for (const [, m] of messages) {
        if (m.id !== existing.id && m.author.id === client.user.id) {
          try { await m.delete(); } catch { /* */ }
        }
      }
      await existing.edit({ embeds: [embed], components });
      console.log('[DemoPanel] Updated Coinbase review demo panel in place');
    } else {
      for (const [, m] of messages) {
        if (m.author.id === client.user.id) { try { await m.delete(); } catch { /* */ } }
      }
      await channel.send({ embeds: [embed], components });
      console.log('[DemoPanel] Posted fresh Coinbase review demo panel');
    }
  } catch (err) {
    console.error('[DemoPanel] Failed to post / refresh demo panel:', err.message);
  }
}

/**
 * Handle the "Launch Onramp Demo" button. Mints a fresh one-click-buy
 * session against the throwaway DEMO_WALLET_ADDRESS and replies with
 * the URL, ephemerally. If the trial counter is exhausted we surface
 * a reviewer-specific message explaining the fallback behavior —
 * crucially, we do NOT silently route to Wert here (reviewers need to
 * see CDP specifically).
 */
async function handleCoinbaseReviewDemoButton(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const demoWallet = process.env.DEMO_WALLET_ADDRESS;
  if (!demoWallet || !/^0x[0-9a-fA-F]{40}$/.test(demoWallet)) {
    return interaction.editReply({
      content: '❌ Demo is not configured. `DEMO_WALLET_ADDRESS` must be set to a valid Base address.',
    });
  }

  if (!onramp.isConfigured()) {
    return interaction.editReply({
      content: '❌ CDP credentials are not configured on this bot.',
    });
  }

  if (!cdpTrial.canUseOnramp()) {
    return interaction.editReply({
      content: [
        '⚠️  **CDP trial allowance is currently exhausted.**',
        '',
        'Coinbase reviewer: this is the expected production behavior — our payment router auto-routes deposits to Wert once the 25-transaction trial cap fills. Approving the trial-mode upgrade will restore full CDP access and let us flip US deposits back to the Coinbase Onramp flow.',
        '',
        `Trial counter: **${cdpTrial.getStatus().count}/${cdpTrial.getStatus().max}**`,
      ].join('\n'),
    });
  }

  const partnerUserRef = `cdp-review-demo-${interaction.user.id}`.slice(0, 49);

  let session;
  try {
    session = await onramp.createOneClickBuySession({
      walletAddress: demoWallet,
      purchaseCurrency: 'USDC',
      destinationNetwork: 'base',
      paymentAmount: String(DEMO_PRESET_USD),
      paymentCurrency: 'USD',
      country: 'US',
      partnerUserRef,
    });
  } catch (err) {
    if (err instanceof onramp.TrialExhaustedError) {
      return interaction.editReply({
        content: '⚠️  CDP trial just hit its cap mid-request. This is expected production behavior — reviewer, approving the upgrade will resolve it.',
      });
    }
    console.error('[DemoPanel] Review demo session failed:', err.message);
    return interaction.editReply({
      content: `❌ Error generating demo session: \`${err.message}\``,
    });
  }

  const buyButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setURL(session.onrampUrl)
      .setLabel('Open Onramp Session')
      .setStyle(ButtonStyle.Link),
  );

  const quoteLine = session.quote?.paymentTotal
    ? `\nPreview: **${session.quote.paymentTotal} ${session.quote.paymentCurrency}** → **${session.quote.purchaseAmount} USDC**`
    : '';

  console.log(`[DemoPanel] Review demo session created for ${interaction.user.tag} (${partnerUserRef})`);

  return interaction.editReply({
    content: [
      '**Coinbase Onramp Demo Session** 🚀',
      '',
      'Click below to open the live Coinbase guest-checkout flow. The URL is a single-use, 5-minute session token.',
      quoteLine,
      '',
      `_Session tag: \`${partnerUserRef}\`_`,
    ].filter(Boolean).join('\n'),
    components: [buyButton],
  });
}

module.exports = {
  postCoinbaseReviewDemoPanel,
  handleCoinbaseReviewDemoButton,
  DEMO_CUSTOM_ID,
};

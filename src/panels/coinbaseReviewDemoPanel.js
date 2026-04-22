// Coinbase CDP review-demo channel.
//
// Public Discord channel (configurable via DEMO_CHANNEL_ID) containing
// a 1:1 REPLICA of the public wallet channel: same "View My Wallet"
// button, same ephemeral wallet view, same deposit / withdraw / cash
// out flows. Reviewers see exactly what a real production user sees
// when they open their wallet.
//
// Two differences from the real wallet channel:
//
//   1. Country restrictions are stripped. A clicker landing on this
//      panel gets routed as if they were in the US, no matter what
//      country they actually registered under. This is because the
//      Coinbase review team can be located anywhere and we need them
//      to exercise the CDP Onramp + Offramp flows end-to-end. See
//      isDemoChannelContext() below — deposit.js and cashOut.js call
//      it and override `country` to 'US' when true.
//
//   2. partnerUserRef logged to payment_events is tagged
//      `cdp-review-demo-<discordId>` so reviewer activity is easy to
//      filter out of the real transaction feed.
//
// Reviewer access: operator configures channel perms so @everyone can
// View + Read (no Send), then sends the Coinbase reviewer a server
// invite. Reviewer joins, goes through normal registration to get a
// wallet, clicks View My Wallet in this channel, and exercises the
// full deposit / cashout flow. Every option (Coinbase / Wert /
// Transak / Bitrefill) is visible regardless of their actual country.

const { buildPublicWalletPanel } = require('./publicWalletPanel');

/**
 * Is this interaction coming from the review demo channel?
 * Used by deposit.js and cashOut.js to strip country restrictions.
 * @param {import('discord.js').Interaction} interaction
 * @returns {boolean}
 */
function isDemoChannelContext(interaction) {
  const demoId = process.env.DEMO_CHANNEL_ID;
  if (!demoId) return false;
  return interaction?.channel?.id === demoId || interaction?.channelId === demoId;
}

/**
 * Post (or refresh) the demo panel in DEMO_CHANNEL_ID. Called from
 * bot startup. Edits the existing panel in place if one is found;
 * otherwise posts fresh. The panel is the exact same shape as the
 * public wallet panel (buildPublicWalletPanel) — reviewers see the
 * same button a real user sees.
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

  const panel = buildPublicWalletPanel(lang);

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existing = botMessages.find(m => m.embeds.length > 0);

    if (existing) {
      for (const [, m] of botMessages) {
        if (m.id !== existing.id) { try { await m.delete(); } catch { /* */ } }
      }
      await existing.edit(panel);
      console.log('[DemoPanel] Updated Coinbase review demo panel in place (wallet replica)');
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log('[DemoPanel] Posted Coinbase review demo panel (wallet replica)');
    }
  } catch (err) {
    console.error('[DemoPanel] Failed to post / refresh demo panel:', err.message);
  }
}

module.exports = {
  postCoinbaseReviewDemoPanel,
  isDemoChannelContext,
};

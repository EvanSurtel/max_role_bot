const { EmbedBuilder } = require('discord.js');

/**
 * Build the server rules embeds for the rules channel.
 */
function buildRulesPanel() {
  const generalEmbed = new EmbedBuilder()
    .setTitle('Server Rules & Match Regulations')
    .setColor(0xe74c3c)
    .setDescription('By participating in any match (wager or XP), you agree to all rules below. Violations result in penalties up to permanent ban and forfeiture of funds.');

  const noShowEmbed = new EmbedBuilder()
    .setTitle('No-Show Rules')
    .setColor(0xf39c12)
    .setDescription([
      '**Wager Matches:**',
      '• You have **10 minutes** from match channel creation to show up',
      '• If you do not join the match voice channel or respond in the match chat within 10 minutes, you can be reported as a no-show',
      '• No-show = automatic forfeit — opponent wins by default',
      '• Staff will verify by checking if the player joined any match voice channels',
      '',
      '**XP Matches:**',
      '• You have **5 minutes** to show up (same as NeatQueue)',
      '• No-show on XP match = **-300 XP penalty** applied by staff',
      '• Repeated no-shows may result in temporary or permanent ban',
      '',
      '**NeatQueue Matches:**',
      '• 5 minutes to show up per NeatQueue rules',
      '• No-show penalties handled by NeatQueue system',
    ].join('\n'));

  const matchRulesEmbed = new EmbedBuilder()
    .setTitle('Match Rules')
    .setColor(0x3498db)
    .setDescription([
      '**General:**',
      '• You MUST use your registered COD Mobile account (matching your registered UID) for all matches',
      '• Playing on someone else\'s account or having someone play for you = permanent ban + forfeiture of funds',
      '• All matches are final once both parties accept',
      '• Both captains must report results honestly after the match',
      '',
      '**Reporting Results:**',
      '• Both captains click **We Won** or **We Lost** in the vote channel',
      '• If both captains agree → match resolved instantly',
      '• If captains disagree → match goes to dispute',
      '• You must report within the allowed time window or the match auto-disputes',
      '',
      '**Disconnection:**',
      '• If a player disconnects during a match, the match continues',
      '• Disconnections are not grounds for a restart unless both teams agree',
      '• Repeated intentional disconnections = forfeit',
      '',
      '**Series Format:**',
      '• Maps are randomly selected by the bot for each game in the series',
      '• Mode rotation follows the selected game mode (HP, S&D, CTRL, or mixed)',
      '• Teams cannot request map changes after the match starts',
    ].join('\n'));

  const wagerRulesEmbed = new EmbedBuilder()
    .setTitle('Wager Rules')
    .setColor(0xf1c40f)
    .setDescription([
      '**Entry & Payouts:**',
      '• Entry amount is per player (both teams pay equal entry)',
      '• Winners receive the full pot split equally among winning team members',
      '• Funds are held (locked from your account) during the match and released when the match is decided',
      '• Minimum wager: $0.50 USDC | Maximum wager: $100 USDC',
      '',
      '**Wallet & Funds:**',
      '• You must have enough USDC balance before creating or accepting a wager',
      '• You need a small amount of SOL for transaction fees (~$0.50 lasts ~100 wagers)',
      '• Funds locked during a match cannot be withdrawn until the match is over',
      '• Minimum withdrawal: $0.50 USDC',
      '',
      '**Cancellation:**',
      '• Only the challenge creator can cancel before it\'s accepted',
      '• Once accepted, the match cannot be cancelled — only disputed',
      '• Cancelled challenges refund all held funds immediately',
    ].join('\n'));

  const disputeRulesEmbed = new EmbedBuilder()
    .setTitle('Dispute Rules')
    .setColor(0x9b59b6)
    .setDescription([
      '**When Disputes Happen:**',
      '• Captains report different winners (disagree)',
      '• A player creates a dispute from the lobby',
      '• No-show is reported',
      '• Match times out without results reported',
      '',
      '**Evidence Requirements:**',
      '• Post evidence directly in the match shared channel',
      '• Valid evidence: screenshots, video recordings, screen recordings',
      '• Evidence must show the match result AND player UIDs',
      '• Timestamped evidence is preferred',
      '',
      '**Resolution:**',
      '• Staff reviews all evidence and decides the outcome',
      '• Staff can award win to either team or declare no winner (full refund)',
      '• Staff decisions are final',
      '• Providing falsified evidence = permanent ban + forfeiture of funds',
      '',
      '**False Reporting:**',
      '• Misreporting match results intentionally = ban',
      '• Intentionally creating false disputes = ban',
      '• Using old/recycled evidence = ban',
    ].join('\n'));

  const prohibitedEmbed = new EmbedBuilder()
    .setTitle('Prohibited Conduct')
    .setColor(0xe74c3c)
    .setDescription([
      '**Zero Tolerance — Permanent Ban + Fund Forfeiture:**',
      '• Cheating, hacking, or using unauthorized software/devices',
      '• Win trading, match fixing, or collusion',
      '• Creating multiple accounts (alts/smurfs) to circumvent bans',
      '• DDoS attacks or network manipulation',
      '• Impersonating staff or other players',
      '• Fraudulent wagers (using matches as money transfer)',
      '• XP boosting (fake matches to inflate XP)',
      '',
      '**Warnings / Temp Ban:**',
      '• Harassment, threats, or abuse toward other players or staff',
      '• Stalling or intentionally delaying matches',
      '• Not reporting match results',
      '• Repeated no-shows',
      '',
      '**Staff reserves the right to ban any user and void any match for any rule violation or behavior deemed harmful to the community.**',
    ].join('\n'));

  return { embeds: [generalEmbed, noShowEmbed, matchRulesEmbed, wagerRulesEmbed, disputeRulesEmbed, prohibitedEmbed] };
}

/**
 * Post rules in the rules channel.
 */
async function postRulesPanel(client) {
  const channelId = process.env.RULES_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] RULES_CHANNEL_ID not set — skipping rules panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds[0]?.title?.includes('Server Rules'));

    const panel = buildRulesPanel();

    if (existingPanel) {
      // Delete all bot messages and repost (multiple embeds can't be edited easily)
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
    }

    await channel.send(panel);
    console.log('[Panel] Posted rules panel');
  } catch (err) {
    console.error('[Panel] Failed to post rules panel:', err.message);
  }
}

module.exports = { buildRulesPanel, postRulesPanel };

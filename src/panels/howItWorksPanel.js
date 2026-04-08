const { EmbedBuilder } = require('discord.js');

function buildHowItWorksPanel() {
  const introEmbed = new EmbedBuilder()
    .setTitle('How It Works')
    .setColor(0x3498db)
    .setDescription('Welcome to Rank $! Here\'s everything you need to know to get started with wager matches and XP matches.');

  const walletExplainEmbed = new EmbedBuilder()
    .setTitle('Step 1: Your Wallet')
    .setColor(0x2ecc71)
    .setDescription([
      'You have a private **wallet channel** in this server. Only you can see it and use it.',
      '',
      'Your wallet holds two things:',
      '• **USDC** — a crypto coin that represents the US dollar. 1 USDC = $1 USD. This is what you wager with. It doesn\'t go up or down in value — $10 USDC is always worth $10.',
      '• **SOL** — a tiny amount needed to process transactions, like a small service fee. ~$0.50 worth of SOL lasts about 100 wagers.',
      '',
      '**Wallet Buttons:**',
      '• **Copy Address** — get your wallet address to receive USDC and SOL',
      '• **Refresh Balance** — check your current balance',
      '• **Withdraw USDC** — send USDC out to an external wallet or exchange',
      '• **Withdraw SOL** — send SOL out to an external wallet',
      '• **History** — view all your transactions',
      '',
      '**Balance types:**',
      '• **Available** — what you can use for wagers or withdraw',
      '• **Held** — locked in an active wager (returned to you when the match is decided)',
    ].join('\n'));

  const cryptoEmbed = new EmbedBuilder()
    .setTitle('Step 2: Fund Your Wallet (Wagers Only)')
    .setColor(0xf1c40f)
    .setDescription([
      '*Skip this step if you only want to play XP matches — they\'re free!*',
      '',
      '**How to get USDC and SOL:**',
      '',
      '**Option 1: Buy on an exchange (easiest)**',
      '1. Download **Coinbase**, **Crypto.com**, or **Binance** on your phone',
      '2. Create an account and verify your identity',
      '3. Add money to your exchange account using your **bank account, debit card, or Apple/Google Pay**',
      '4. Once your money is in the exchange, buy **USDC** (however much you want to wager)',
      '5. Also buy a tiny amount of **SOL** (~$0.50–$1 worth)',
      '6. Now you need to send the USDC and SOL to your server wallet:',
      '   → Go to your **wallet channel** in this Discord server',
      '   → Click **Copy Address** to get your deposit address',
      '   → Back in your exchange app, go to **Withdraw** or **Send**',
      '   → Select **USDC**',
      '   → ⚠️ **YOU MUST choose Solana network** — if you pick the wrong network (Ethereum, BSC, etc.) your money **WILL BE LOST FOREVER** and cannot be recovered',
      '   → **Double-check your wallet address** — paste it directly from your wallet channel. Crypto transfers **cannot be reversed**.',
      '   → Confirm and send',
      '   → Then do the same for **SOL** — select **SOL**, choose **Solana network**, paste your wallet address, confirm and send',
      '7. Wait about 30 seconds — the bot detects your deposit automatically',
      '8. Click **Refresh Balance** in your wallet channel to confirm it arrived',
      '',
      '**Option 2: Get from a friend**',
      'Have someone send USDC and SOL directly to your wallet address. Make sure they send on the **Solana network**.',
      '',
      'USDC represents the US dollar — $10 USDC = $10 USD, it doesn\'t go up or down in value.',
    ].join('\n'));

  // walletEmbed moved to walletExplainEmbed above cryptoEmbed

  const wagerEmbed = new EmbedBuilder()
    .setTitle('How Wager Matches Work')
    .setColor(0xf1c40f)
    .setDescription([
      '**Creating a wager:**',
      '1. Go to the **wager lobby** channel and click **Create Wager**',
      '2. Choose your **team size** (1v1, 2v2, 3v3, 4v4, or 5v5)',
      '3. Pick your **teammates** (if team match — they\'ll get a notification to accept)',
      '4. Choose the **game mode** (HP, S&D, Control, or mixed rotations)',
      '5. Choose the **series length** (Best of 1, 3, 5, or 7)',
      '6. Choose **visibility** — this means whether other players can see who created the challenge or if it stays anonymous. Anonymous means opponents won\'t know who they\'re up against until they accept.',
      '7. Enter your **wager amount** — this is how much each player puts in (e.g. $5 means each player risks $5)',
      '8. Confirm and create',
      '9. Your entry amount is held from your wallet (you can\'t spend it until the match is over)',
      '10. Your challenge gets posted to the **challenge board** channel where other players can see it and accept it',
      '',
      '**Accepting a wager:**',
      '1. Go to the **wager challenges** channel — this is where all open challenges are posted',
      '2. Find a challenge you want to play and click **Accept Challenge**',
      '3. Pick your teammates (if it\'s a team match)',
      '4. Review the full match details and confirm — your entry is held from your wallet',
      '5. Match channels are created automatically for both teams',
      '',
      '**What happens when a match starts:**',
      'The bot creates a private set of channels just for your match:',
      '• **Team 1 text & voice** — only your team can see and talk here',
      '• **Team 2 text & voice** — only the other team',
      '• **Shared chat & voice** — both teams can talk here',
      '• **Vote channel** — where captains report who won after the match',
      '',
      'The bot will randomly pick maps for each game in the series. Both teams can see the map picks in the shared channel.',
      '',
      '**You must join a voice channel within 15 minutes or you will be forfeited.** The bot will remind you at 5 and 10 minutes if you haven\'t joined.',
      '',
      '**After the match — reporting results:**',
      '1. Go to the **vote** channel in your match',
      '2. Both team captains must report the result by clicking **We Won** or **We Lost**',
      '3. You\'ll get a confirmation screen to make sure you didn\'t misclick',
      '4. If both captains agree on who won → the match is resolved instantly and the winner gets paid',
      '5. If the captains disagree → the match goes to **dispute** and staff will review evidence to decide the winner',
      '',
      '**How payouts work:**',
      '• The full pot (everyone\'s entry combined) is split equally among the winning team',
      '• Example: 2v2 with $5 entry each = $20 pot. Winning team of 2 gets $10 each (their $5 back + $5 profit)',
      '• Winnings go directly into your wallet — you can withdraw to your exchange anytime',
    ].join('\n'));

  const xpEmbed = new EmbedBuilder()
    .setTitle('How XP Matches Work')
    .setColor(0x3498db)
    .setDescription([
      'XP matches work the same as wagers but with **no money** — you play for XP rankings.',
      '',
      '**Creating an XP match:**',
      '1. Go to the **XP match** channel',
      '2. Click **Create XP Match**',
      '3. Choose: team size → teammates → game mode → series → visibility',
      '4. No entry amount needed — it\'s free',
      '',
      '**XP System (ELO-based):**',
      '• Beating a stronger team earns more XP',
      '• Beating a weaker team earns less XP',
      '• Losing to a stronger team loses less XP',
      '• Everyone starts at 500 XP each season',
      '',
      '**XP Queue matches** are run separately through NeatQueue with static +100/-60 XP.',
      'All XP from wagers, XP challenges, and queue matches is combined.',
    ].join('\n'));

  const tipsEmbed = new EmbedBuilder()
    .setTitle('Tips & FAQ')
    .setColor(0x95a5a6)
    .setDescription([
      '**Q: What is USDC?**',
      'A: USDC is a crypto coin that represents the US dollar. 1 USDC = $1 USD. Unlike Bitcoin, USDC doesn\'t go up or down in value — $10 USDC is always worth $10.',
      '',
      '**Q: What is SOL?**',
      'A: SOL is what pays the small processing fees when you send or receive money. Think of it like a tiny service fee. ~$0.50 worth of SOL lasts about 100 wagers.',
      '',
      '**Q: Can I lose more than my entry?**',
      'A: No. You only risk your entry amount. Winners get their entry back plus the loser\'s entry.',
      '',
      '**Q: How fast are payouts?**',
      'A: Instant. As soon as both captains confirm the result, winnings are in your wallet.',
      '',
      '**Q: Can I cancel a wager?**',
      'A: Only before someone accepts it. Once accepted, the match must be played.',
      '',
      '**Q: What if my opponent doesn\'t show up?**',
      'A: Report a no-show after 15 minutes. Staff will verify and you win by forfeit.',
      '',
      '**Q: What exchanges can I use?**',
      'A: Coinbase, Crypto.com, Binance, Kraken, or any exchange that supports USDC on Solana.',
    ].join('\n'));

  return { embeds: [introEmbed, walletExplainEmbed, cryptoEmbed, wagerEmbed, xpEmbed, tipsEmbed] };
}

async function postHowItWorksPanel(client) {
  const channelId = process.env.HOW_IT_WORKS_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] HOW_IT_WORKS_CHANNEL_ID not set — skipping');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }

    const panel = buildHowItWorksPanel();
    await channel.send(panel);
    console.log('[Panel] Posted how it works panel');
  } catch (err) {
    console.error('[Panel] Failed to post how it works panel:', err.message);
  }
}

module.exports = { buildHowItWorksPanel, postHowItWorksPanel };

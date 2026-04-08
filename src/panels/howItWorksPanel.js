const { EmbedBuilder } = require('discord.js');

function buildHowItWorksPanel() {
  const introEmbed = new EmbedBuilder()
    .setTitle('How It Works')
    .setColor(0x3498db)
    .setDescription('Welcome to Rank $! Here\'s everything you need to know to get started with wager matches and XP matches.');

  const cryptoEmbed = new EmbedBuilder()
    .setTitle('Step 1: Fund Your Wallet (Wagers Only)')
    .setColor(0xf1c40f)
    .setDescription([
      '*Skip this step if you only want to play XP matches — they\'re free!*',
      '',
      '**What you need:**',
      '• **USDC** — a crypto coin that represents the US dollar. 1 USDC = $1 USD. This is what you wager with.',
      '• **SOL** — a tiny amount needed to process transactions, like a small fee. ~$0.50 worth lasts about 100 wagers.',
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
      '   → Select **USDC**, choose **Solana network**, paste your wallet address, and send',
      '   → Then select **SOL**, choose **Solana network**, paste your wallet address, and send',
      '7. Wait about 30 seconds — the bot detects your deposit automatically',
      '8. Click **Refresh Balance** in your wallet channel to confirm it arrived',
      '',
      '**Option 2: Get from a friend**',
      'Have someone send USDC and SOL directly to your wallet address on the Solana network.',
      '',
      '**⚠️ IMPORTANT — READ BEFORE SENDING:**',
      '• **ALWAYS select Solana network** when withdrawing/sending from the exchange. If you choose the wrong network (Ethereum, BSC, etc.) your funds **WILL BE LOST** and cannot be recovered.',
      '• **Double-check your wallet address** before sending — copy it directly from your wallet channel. Crypto transfers **cannot be reversed**.',
      '• USDC represents the US dollar — $10 USDC = $10 USD, it doesn\'t go up or down in value.',
    ].join('\n'));

  const walletEmbed = new EmbedBuilder()
    .setTitle('Your Wallet')
    .setColor(0x2ecc71)
    .setDescription([
      'After registering, you get a private **#wallet** channel. Only you can see it.',
      '',
      '**Buttons:**',
      '• **Copy Address** — get your deposit address to receive USDC and SOL',
      '• **Refresh Balance** — check your current balance',
      '• **Withdraw USDC** — send USDC to an external wallet or exchange',
      '• **Withdraw SOL** — send SOL to an external wallet',
      '• **History** — view all your transactions',
      '',
      '**Balance types:**',
      '• **Available** — what you can use for wagers or withdraw',
      '• **Held** — locked in an active wager (released when match is decided)',
    ].join('\n'));

  const wagerEmbed = new EmbedBuilder()
    .setTitle('How Wager Matches Work')
    .setColor(0xf1c40f)
    .setDescription([
      '**Creating a wager:**',
      '1. Go to the **wager lobby** channel',
      '2. Click **Create Wager**',
      '3. Choose: team size → teammates (if team) → game mode → series → visibility → entry amount',
      '4. Confirm and create',
      '5. Your entry amount is held from your wallet',
      '6. Your challenge appears on the challenge board',
      '',
      '**Accepting a wager:**',
      '1. Go to the **wager challenges** channel',
      '2. Click **Accept Challenge** on a challenge you want to play',
      '3. Choose teammates (if team match)',
      '4. Confirm — your entry is held from your wallet',
      '5. Match channels are created automatically',
      '',
      '**Playing the match:**',
      '1. Join your team\'s voice channel',
      '2. The bot randomly selects maps for each game',
      '3. Play your matches in CODM',
      '',
      '**Reporting results:**',
      '1. After the match, go to the **vote** channel',
      '2. Both captains click **We Won** or **We Lost**',
      '3. If both agree → winner gets paid automatically',
      '4. If they disagree → dispute (staff reviews evidence)',
      '',
      '**Payouts:**',
      '• Winners split the full pot equally',
      '• Winnings go directly to your wallet balance',
      '• You can withdraw anytime from your wallet channel',
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

  return { embeds: [introEmbed, registrationEmbed, cryptoEmbed, walletEmbed, wagerEmbed, xpEmbed, tipsEmbed] };
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

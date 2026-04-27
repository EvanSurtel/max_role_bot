# Rank $ — How It All Works

A plain-English walkthrough of the platform. Written for someone planning marketing, partnerships, or onboarding — not for developers. No code, no tech stack, just the user's story end-to-end.

---

## What Rank $ is in one sentence

Rank $ is a Discord-based platform where Call of Duty Mobile players can play **free XP matches** or wager real money on **cash matches** in any team format (1v1, 2v2, 3v3, 4v4, or 5v5), join a 5v5 ranked queue, and climb a global XP rank ladder — with one important difference from every competitor: **the money never leaves the player's own wallet until they choose to play**, and **the platform can't touch it**.

---

## What makes it different

Most competitive gaming platforms (CMG, GameBattles, Players' Lounge) hold your money. You deposit, they keep it in their custody, and they decide when to release it. If they get hacked, mismanaged, or simply decide to freeze your account, you have no real recourse. Players have lost real money to platforms shutting down or freezing balances overnight.

Rank $ is built on a fundamentally different model: **self-custody**. When a player deposits, the money goes into a wallet that they own — locked by their phone's Face ID, Touch ID, or fingerprint. Rank $ doesn't have the keys. We can't move funds. We can't freeze accounts. We can't seize balances.

The only way money leaves a player's wallet is when **they** sign with their own face or fingerprint to enter a match they want to play, up to a daily spending limit they set themselves. If Rank $ disappeared tomorrow, every player would still have full access to their funds.

This isn't a marketing claim — it's a technical guarantee that Coinbase reviewed and signed off on at the architecture level in April 2026. It's the model that lets us be a real-money platform without holding any user money.

**Three things players will hear that no competitor can credibly say:**

1. "Your money is in your wallet, not ours."
2. "We charge zero fees on deposits, withdrawals, or matches."
3. "If we shut down tomorrow, you keep your money."

### Free XP play is a first-class feature, not an afterthought

Players don't have to put in a single dollar to use the platform. Rank $ has **three distinct ways to play**, all using the exact same match flow and the exact same XP / rank system:

- **XP Matches** — Free 1v1, 2v2, 3v3, 4v4, or 5v5 matches in any game mode, any series length. Same captain-creates-and-picks-teammates flow as cash matches; the only difference is no money. Win XP, climb the ladder.
- **Cash Matches** — Same team-size options, same flow, but each player puts in real USDC (minimum 50 cents per player) and the winners take the pot.
- **5v5 Ranked Queue** — Solo queue. The bot fills 10-player Hardpoint Bo3 lobbies, runs captain voting + snake-draft, and pays out XP only.

**Every match type feeds the same rank ladder** — Bronze → Silver → Gold → Platinum → Diamond → Sentinel → Obsidian → Crowned (top 10). A player can grind to Diamond on free XP matches and the queue, then start playing for money at the rank they earned. Or never touch cash and still hold a top-10 rank. Same nickname, same leaderboard, same emblems regardless of how the XP was earned.

This matters for marketing: most players never deposit a dollar. They're in it for the rank, the bragging rights, and the matchmaking. Cash matches are the **upsell**, not the gate.

---

## The user journey from joining

### Step 1 — Joining the server

A new player joins the Discord server. They land in a welcome channel where they see a panel from the bot explaining what Rank $ is. Until they accept the Terms of Service, they can't see anything else in the server — just the welcome and a "Choose your language" picker. We support 20 languages including English, Spanish, Portuguese, French, German, Russian, Arabic, Hindi, Japanese, Korean, Chinese, Vietnamese, Indonesian, Thai, and more.

The TOS panel breaks the rules into 4 readable embeds. The player clicks **Accept** at the bottom.

### Step 2 — Registering

After accepting TOS, the player clicks **Register**. A form pops up asking for:

- Their **display name** (what other players see — not their Discord username)
- Their **Call of Duty Mobile in-game name** (so opponents know who they're playing)
- Their **Call of Duty Mobile UID** (the unique numeric ID inside CODM — this prevents one player from using two Discord accounts to wager against themselves)
- Their **region** (NA, EU, LATAM, Asia, MEA) — affects payment methods we offer
- Their **country** (drops down with flags)

When they submit, the bot:
- Stores their info
- Gives them a **Member** role in Discord, which unlocks the rest of the server
- Sets their nickname to `Name 🇺🇸 [500] [$0.00]` — that's their starting XP and earnings, visible to everyone

### Step 3 — The fork in the road

After registering, the player sees a message:

> **You're registered — you can play free XP matches and the ranked queue right now.**
> Just want XP / ranked? You're done. Head to the match lobby and play. **No wallet needed.**
>
> **Want to play cash matches too?** Set up your self-custody wallet (takes 30 seconds): 🔐 [setup link]

This is intentional. We don't force anyone into a wallet. A player who just wants to grind ranked can do that immediately, never touching crypto, never seeing a deposit screen. A player who wants real-money matches sets up their wallet on their own time.

---

## The wallet — what it is and how it works

### What is "self-custody"?

When a player clicks the setup link, their browser opens Coinbase's wallet creation page. They:

1. Enter their email (just to anchor the wallet — they don't need a Coinbase account)
2. Use their phone or computer's built-in passkey (Face ID, Touch ID, Windows Hello, fingerprint, or a hardware security key)
3. Their passkey becomes the lock on their wallet — only they can unlock it

That's it. They now own a real cryptocurrency wallet on the **Base** network (a fast, low-cost network built by Coinbase). Their money lives in this wallet. Rank $ never sees the passkey. Rank $ has no way to sign transactions on their behalf for withdrawals.

The currency in every wallet is **USDC** — digital US dollars. One USDC = one US dollar, always. When a player has $50 in their wallet, they have fifty US dollars. They hold dollars, earn dollars, and cash out dollars.

### The daily spending limit

When the player sets up their wallet, they pick a **daily spending limit**: $50, $200, or $1,000. This is the most they personally want to put into cash matches in any 24-hour window — like a daily budget they set for themselves. The bot enforces this on their behalf: even if they have $5,000 in their wallet, if their daily limit is $200 and they've already used $200 today, the bot blocks the next match entry.

They can raise it, lower it, or turn it off any time. Important: this is a **player-set** limit, not a platform-imposed restriction. The framing matters a lot for marketing — it's a feature for the player, not a leash from us.

### How the daily limit actually works

This is the technical magic that makes self-custody work at all. Normally, if Rank $ doesn't hold the money, how does the bot start a match without asking the player to manually sign every entry?

Answer: when the player sets their daily limit, they sign a single permission slip that says "Rank $ can pull up to $X per day from my wallet, only for match entries, only when I confirm a match." This is called a **Spend Permission** and it's a Coinbase-built feature. The player signs it once with their passkey. After that, the bot can debit match entries silently up to the daily cap — but **only** for match entries, and **never** for withdrawals, and **never** beyond the cap.

If the bot ever tried to pull more than the player allowed, the on-chain contract would reject it. The player can revoke the permission any time.

---

## Money flow — deposits, withdrawals, sending

### Depositing money

A player clicks **💵 Deposit** in their wallet panel and enters how much they want to add.

What they see depends on where they live:

- **🇺🇸 In the US** — One button: "Deposit with Apple Pay, Google Pay, or Debit Card." Guest checkout — no Coinbase account, no ID, no fees. Money lands in their wallet within minutes. Powered by Coinbase Onramp.

- **🇬🇧 In the UK** — One button: "Deposit with Apple Pay, Google Pay, Card, or PayPal." Sign in to a free Coinbase account, verify ID once. They'll need that same account if they ever want to cash out to a UK bank later, so it's a one-time setup.

- **🌍 Everywhere else** — One button: "Deposit with Card, Apple Pay, or Google Pay — no fees (sign in and ID required)." Sign in to a free Coinbase account, verify ID once. _A no-account guest checkout for non-US/UK is in the works with our partner and will roll out soon._

There's also an option to **send USDC directly** from any other wallet on the Base network. Useful for crypto-native users who already have funds elsewhere. The wallet panel shows the player's address — they copy it and send to it from anywhere.

**Critical safety messaging:** USDC must be sent on the **Base network only**. Sending on Ethereum, Solana, or any other chain means lost funds forever — no one can reverse it. We hammer this in the UI.

### Cash-out

A player clicks **Withdraw** in their wallet panel. They see three options:

- **💵 Cash to Bank, Card, or PayPal** — Sign in to a Coinbase account, verify ID, pick how to receive. Money arrives in minutes. (If they signed in during deposit, they don't repeat the setup — same account.)

- **🎁 Spend on Gift Cards (no ID needed)** — Buy gift cards for Amazon, Steam, Apple, Uber, and 1,000+ brands. No ID required for orders up to ~$500. Effective fee 0–3% depending on brand. Powered by Bitrefill.

- **📤 Send USDC to Any Wallet** — They paste any Base-network wallet address, sign with their passkey, funds go directly. Same network warning as deposits.

**The whole withdrawal flow is signed by the player's passkey.** Rank $ has zero ability to move their money, even at the operator level. This is a hard architectural limit, not a policy choice — preserved for FinCEN compliance under the "unhosted wallet" classification.

### Sending to another player

Players can also send USDC directly to other players on the platform. From the wallet panel, click **📤 Send to User**:

1. Pick the player from a dropdown of registered users with wallets
2. Type the amount
3. The bot DMs a one-click signing link
4. They sign with their passkey

Use cases: paying off a side bet, splitting a pot the bot doesn't know about, tipping a content creator, settling a friendly disagreement after a match. We make it as easy as paying a friend on Venmo or Cash App, but the money moves on the blockchain in seconds with no fees.

---

## Cash match flow — start to finish

### Creating a cash match

In the match lobby, a player clicks **Create Cash Match**. They go through a short setup:

1. **Team size:** 1v1, 2v2, 3v3, 4v4, or 5v5
2. **Teammates:** if it's a team match, they pick the players they want on their team. Their teammates get a Discord DM — they accept or decline. (If a teammate has DMs disabled, the bot tells the captain immediately so they can pick someone else.)
3. **Game mode:** Hardpoint, Search & Destroy, Control, or any rotation of the three
4. **Series length:** Best of 1, 3, 5, or 7
5. **Entry amount:** how much each player puts in (minimum 50 cents)
6. **Confirm**

When they confirm, their entry is **locked in their wallet**. They can't spend it elsewhere until the match either finishes or is cancelled. Their teammates' entries are locked the same way when they accept.

### Posting the challenge

Once everyone on the captain's team has accepted, the challenge appears on the **public challenge board** — a Discord channel anyone in the server can browse. It shows:

- Team size, game mode, series length
- Entry amount per player
- Total match prize (entry × players)
- Who created it (or "anonymous" if they chose that option)

The challenge sits there for **1 hour** waiting for an opponent. During that hour:
- The creator can click **Extend +10 min** to give it more time (matches CMG's behavior)
- The creator can click **Cancel** to take it down and get refunded
- If no one accepts in 1 hour, it auto-expires and the entry is automatically refunded — the player gets a DM letting them know

### Accepting a challenge

Another player clicks **Accept Challenge**. If it's a team match, they pick their teammates the same way the captain did. Their teammates accept via DM. Once everyone is in:

- All entries are pulled out of every player's wallet, on-chain, into a smart contract called **WagerEscrow**
- The smart contract holds the prize until the match resolves
- Match channels are created in Discord — private team voice + text channels, plus a shared chat where both teams talk, plus a "vote" channel where captains report results

This is where the self-custody design shines. The bot doesn't hold the money — it pulls each player's entry directly from their own wallet, into the escrow contract, in a single atomic transaction. If any player's entry can't be pulled (insufficient funds, daily limit hit, etc.), the whole thing reverts and no money moves.

### Playing the match

The teams play the match in Call of Duty Mobile. The bot doesn't watch the game — players use their own CODM private lobbies. The bot's job is to coordinate channels, start timers, and handle the result.

Players have **15 minutes** to show up after the match channels are created. No-shows are forfeit; the opponent wins by default.

### Reporting results

After the match ends, both team captains click **We Won** or **We Lost** in the vote channel.

- **If they agree** (both say the same team won): money pays out instantly. Winners get the match prize sent directly to their wallets, on-chain. Each winner sees their entry back **plus** their share of the loser's entry. The bot also updates everyone's XP and adjusts their rank if they crossed a tier.

- **If they disagree** (one says team 1 won, the other says team 2 won): the match goes to **dispute**. Players submit evidence (screenshots, recordings) in the dispute channel. Staff review and resolve. Winners get paid.

- **If neither captain reports within ~24 hours**: the match auto-disputes and staff resolves it.

### Payout — the magic moment

Imagine a 2v2, $5 entry per player. Total prize: $20 in the escrow contract. Team 2 wins. Each winner gets $10 back ($5 of their own entry + $5 from the losers). The transaction settles on the blockchain in about 2 seconds. Rank $ takes **zero fees**. The losers see -$5 in their balance.

Money lands in the winners' wallets immediately — they can withdraw, deposit more, send to friends, or play another match right away. There's no holding period, no admin approval, no fee. It just happens.

---

## XP matches and the ranked queue — free play

Not every match is for money. Most aren't.

### XP Challenges

Same flow as cash matches and the same team-size options — **1v1, 2v2, 3v3, 4v4, and 5v5** — captain creates, picks teammates, posts to a challenge board, opponent accepts, teams play, captains report. The only difference: no money. Winners earn XP based on **how strong their opponent was** — beating a stronger team is worth more XP than stomping a weaker one. Losing to a much stronger team costs less XP than losing to a much weaker one.

This is the bread-and-butter of the platform. Most players start with XP matches to learn the ropes, build up XP, and figure out who's good before risking real money.

### Ranked Queue (5v5)

The crown jewel of the free-play side. Players join a queue from a panel in the queue channel. Once 10 players are in, the bot:

1. Auto-creates a match category with team channels
2. Players vote for two captains
3. Captains snake-draft their teams (highest pick first, then alternating)
4. Each player picks weapon roles (AR, SMG, LMG, Shotgun, Marksman, Sniper) and an operator skill — limited slots per team to enforce variety
5. Players play 5v5 Hardpoint, Best of 3
6. Captains report the result
7. Winners gain 100 XP, losers lose 60 XP. (XP can never go below 0 — players can't be punished into negative.)

The queue runs forever. If a player sits in queue for an hour without it filling, they get gracefully removed and notified — but the queue itself stays open for everyone else.

If a player no-shows the voice channel after the queue fills, they take a **-300 XP penalty** and the bot tries to find a replacement from the waiting queue, sorted by closest XP. If no replacement is available and there aren't enough players to continue, the match cancels and players are offered a re-queue button.

---

## Rank progression

XP earned across all match types feeds into a **global rank**. Ranks are visible to everyone via the player's nickname (`Name 🇺🇸 [XP] [$Earnings]`) and via a `/rank` command that shows a stylized rank card image.

Ranks from lowest to highest:

| Rank | XP threshold |
|---|---|
| Bronze | 0+ |
| Silver | 750+ |
| Gold | 1,500+ |
| Platinum | 2,250+ |
| Diamond | 3,000+ |
| Sentinel | 3,750+ |
| Obsidian | 4,500+ |
| **Crowned** | Top 10 players on the global leaderboard (position-based, not XP-threshold) |

Each rank has a unique emblem. When a player crosses into a new rank, they get a DM congratulating them and their rank role updates in Discord automatically. When they drop a tier, they're DMed too (the only DMs the bot sends — we don't spam).

Every season, XP resets to 500 for everyone and the ladder starts fresh. Past seasons live in a permanent historical leaderboard, so a player's record is preserved.

---

## The wallet panel — what a player sees

When a player clicks **View My Wallet** in the wallet channel, they see (privately, only they see it):

- Their wallet address (in a copyable code block)
- Their current balance (e.g. `$5.50 USDC`)
- Buttons:
  - **💵 Deposit** — adds money
  - **Withdraw** — cash out (three sub-options as described above)
  - **📤 Send to User** — send to another player on the platform
  - **Copy Address** — convenient long-press copy on mobile
  - **🔄** — refresh the balance
  - **History** — see past deposits, withdrawals, match entries, payouts

It's intentionally simple. We don't show wallet addresses, transaction hashes, gas fees, or any blockchain jargon by default. Players see dollars, balances, and buttons.

---

## Match-result transparency — the audit trail

Every match outcome posts to public results channels in Discord:

- **All Results** — every match, both XP and cash, in one feed
- **Cash Match Results** — cash matches only

Each result post shows:
- Winners (with their handles + how much XP they gained + how much money for cash matches)
- Losers (with their handles + how much XP they lost — or none if it was a cash match)
- Game mode, series length, team size

Staff and any player can scroll the history. Combined with the public on-chain record (every match payout is a verifiable Base blockchain transaction), this gives the platform a transparency that no traditional gaming platform has — there's literally no way for the platform to fudge results or hide a payout.

---

## Anti-cheating and self-play protection

A few things we enforce to keep the platform clean:

- **Self-play check** — A player can't accept their own challenge with a second Discord account that has the same Call of Duty Mobile UID. Same UID on both teams of a 2v2 = blocked. This stops the most common money-farming exploit on competing platforms.

- **Cross-system busy check** — A player can't be in a cash match and a queue match at the same time, or a queue match and an XP challenge. They commit to one match at a time.

- **Daily entry rate limit** — Hard cap of 10 cash match entries per 24-hour window per player. Stops grief / spam.

- **Rate limiting on withdrawals** — 3 withdrawals per 24-hour window. Doesn't restrict the player from accessing their money — just prevents their wallet from being used as an attack surface (e.g. if their Discord gets hacked).

---

## What the platform doesn't do

This list matters as much as what we DO do. For marketing and compliance:

- **We don't hold player money.** Players hold their own keys, in their own wallets. We have no way to seize, freeze, or move funds at the operator level.

- **We don't take fees.** Zero fees on deposits, zero fees on withdrawals, zero rake on matches. Any fee a player sees in the deposit picker (e.g. 4% from a card processor) goes to the third-party payment provider — not us.

- **We don't hold any KYC information beyond what Coinbase's onramp partner requires for fiat-to-crypto** (the same KYC anyone would do to buy USDC anywhere). Discord username, COD in-game name, and COD UID are the only identifiers we ourselves store.

- **We don't run our own payment rails.** Coinbase handles fiat onramp; Coinbase handles cash-out to bank/card/PayPal; Bitrefill handles gift card cash-out; Wert/Transak handle additional onramp routes for non-US/UK regions. We're the matchmaking and escrow layer; payment is third-party throughout.

- **We don't custody funds during disputes.** During a dispute, the prize is held by the **WagerEscrow smart contract** on the blockchain — not by us. Once staff resolves the dispute, the contract pays the winner directly. We can't divert it.

- **We don't run our own KYC.** A player who plays only XP matches and the ranked queue does not need any ID. A player who wants to onramp via card or cash out to bank goes through Coinbase's KYC, which is industry-standard.

---

## Why this matters for marketing

A few angles that resonate, organized loosely from "casual gamer" to "crypto-skeptic" to "competitive grinder":

### For the casual gamer

> "Free-to-play XP matches in any team format (1v1 through 5v5) plus a 5v5 ranked queue. Climb a global leaderboard. Show off your rank. Money is optional — most players never deposit a cent."

### For the crypto-skeptic

> "It's not Bitcoin. It's digital US dollars (USDC). Your $50 today is $50 next month. No price swings. No 'crypto investment' anxiety. You're just holding dollars in a wallet that only YOU can unlock."

### For the platform-burned veteran

> "Your money lives in YOUR wallet, not ours. We can't freeze it, take it, or run off with it. We have no admin override on user funds. If we shut down tomorrow, your wallet still works and you still have all your USDC. This is a guarantee enforced by the blockchain itself, not a marketing promise."

### For the competitive grinder

> "Real cash matches with instant on-chain payouts — no holding periods, no withdrawal fees, no platform rake. 5v5 ranked queue in the same server. Cross-system rank progression. Compete for actual money or play for free. Your call."

### For the deal-conscious

> "Zero fees. Period. Deposit fees, withdrawal fees, match fees — all zero. The only fee you'll ever pay is the third-party card processor on a deposit, and we're rolling out fee-free guest checkout in more regions every month."

### For the partnership / brand pitch

> "Built on Coinbase's infrastructure (Base network, Smart Wallets, Onramp, Spend Permissions), reviewed and signed off by Coinbase's team in April 2026 for self-custody compliance. The first competitive gaming platform that lets players keep their funds while still settling matches in seconds."

---

## A typical player's first 24 hours

To give a feel for the experience:

**Day 1, hour 0** — Player joins the server from a TikTok of someone winning a $50 match. Sees the welcome panel. Picks Spanish as their language. Reads the TOS.

**Hour 0:05** — Clicks Accept. Fills out the registration form. Gets the Member role. Their nickname becomes `Esteban 🇲🇽 [500] [$0.00]` — visible to the whole server.

**Hour 0:10** — Heads to the lobby. Doesn't have a wallet yet. Creates a free **XP Match** to test the platform out. Picks 1v1, Hardpoint, Best of 1. Posts to the board.

**Hour 0:30** — Another player accepts. They get put in match channels. Play. Esteban wins. Earns 87 XP (his opponent was lower-ranked so the win was worth less than a base 100). His nickname updates: `Esteban 🇲🇽 [587] [$0.00]`.

**Hour 1** — Plays another XP match. Loses. -42 XP. Nickname now `Esteban 🇲🇽 [545] [$0.00]`.

**Hour 2** — Wants to try a cash match. Goes to wallet channel, clicks **View My Wallet**. Sees the "set up your wallet" prompt. Clicks the link. On the web page, enters his email, uses Face ID to make a passkey, picks a $50 daily spending limit, signs.

**Hour 2:02** — Wallet is set up. Address shows in his panel. Balance: $0.00. Deposits $20 with Apple Pay (US guest checkout). Funds arrive in his wallet 90 seconds later. Balance: $20.00.

**Hour 2:05** — Creates a 1v1 cash match, $2 entry. Locks $2 in his wallet (visible to him — the $2 is "held"). Posts to the cash board.

**Hour 2:15** — Someone accepts. Match starts. They play. Esteban loses. Loser pays winner. His balance drops from $20 to $18.

**Hour 2:30** — Plays another. Wins. Wins $4 ($2 back + $2 prize). Balance: $22.

**Hour 3** — Joins the 5v5 ranked queue. Waits 12 minutes for it to fill. Plays. His team wins. +100 XP. Nickname now `Esteban 🇲🇽 [710] [$2.00]`.

**End of day 1** — Esteban has played 5 matches across XP and cash, has $22 in his self-custody wallet, sits at 710 XP (just past the Silver tier threshold), and didn't pay a single platform fee. He's hooked.

---

## What's coming next

Things in active development or planned:

- **Tournaments** — bracket-style multi-round events with bigger prize pools
- **Team profiles** — registered teams with their own pages, stats, and match history
- **Spectator mode** — public match viewing for popular cash matches with high stakes
- **Mobile-first wallet** — a dedicated mobile experience instead of the browser-passkey flow
- **More languages and regional payment methods** — wider onramp coverage for non-US/UK regions
- **Streamer integrations** — overlays for content creators showing live match outcomes

---

## The one-liner pitch

> "Rank $ is the first Discord-based Call of Duty Mobile platform where you keep your money in your own wallet, pay zero fees, and settle real-cash matches in seconds on-chain — built on Coinbase, secured by your face."

That's the elevator pitch. Everything else in this document is the supporting detail.

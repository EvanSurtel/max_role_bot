/**
 * Landing page. Users normally never see this — they arrive at
 * /setup, /withdraw, or /renew via a one-time link the Discord
 * bot DMed them. This page exists to (a) confirm the deploy is
 * live and (b) give a Coinbase reviewer a place to land if they
 * navigate to the bare domain.
 */
export default function Page() {
  return (
    <main>
      <h1>Rank $ Wallet</h1>
      <p>
        This is the self-custody wallet surface for the Rank $ Discord bot.
        You normally arrive here via a one-time link the bot sends you in
        Discord — you should not need to visit this page directly.
      </p>

      <div className="card">
        <h2>How it works</h2>
        <p>
          Each Rank $ player has their own Coinbase Smart Wallet on Base.
          You own it via your device passkey (Face ID, Touch ID, Windows Hello,
          security key) — Rank $ never holds your private key.
        </p>
        <p>
          Funding, in-app actions, and external withdrawals all happen with
          your explicit signature. The bot can only pull funds within the
          spending allowance you set, and you can revoke that allowance at
          any time on-chain.
        </p>
      </div>

      <p className="muted">
        Coinbase Developer Platform reviewer? You can join the Discord server
        from the invite in the application; once you join, the bot will DM
        you a link to set up your own wallet here.
      </p>
    </main>
  );
}

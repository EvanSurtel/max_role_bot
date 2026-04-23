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
          Each Rank $ player has their own crypto wallet on Base, locked by
          your phone or computer&apos;s built-in passkey (Face ID, Touch ID,
          Windows Hello, security key). <strong>Only you can sign — Rank $
          never holds your private key.</strong>
        </p>
        <p>
          When you join matches, Rank $ pulls funds from your wallet up to a
          <strong> daily limit you set yourself</strong> — like a daily debit-card
          limit. You&apos;re not pre-paying anything; the limit just caps how
          much can be charged, so you don&apos;t have to approve every match
          one by one.
        </p>
        <p>
          You can change or turn off that limit anytime, and you can send your
          USDC out to any other wallet whenever you want — your funds, your
          control.
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

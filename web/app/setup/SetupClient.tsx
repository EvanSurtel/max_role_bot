'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Wallet setup flow — client portion.
 *
 * Lives separately from page.tsx because Next.js 15's static
 * prerender pass refuses to render client hooks (useSearchParams,
 * useRouter, etc) outside a <Suspense> boundary. The server
 * component in page.tsx wraps this in <Suspense>.
 *
 * Shape (full implementation in next pass):
 *   1. Read one-time link nonce from ?t=...
 *   2. POST /api/link/redeem to exchange nonce -> Discord ID
 *   3. ConnectWallet via OnchainKit (passkey ceremony)
 *   4. Construct + have user sign EIP-712 SpendPermission
 *   5. POST /api/wallet/grant {discordId, smartWalletAddress, permission, signature}
 *      -> bot backend persists, lifts on-chain via approveWithSignature
 *   6. Show success + link back to Discord
 *
 * For the initial Vercel deploy this page renders the UI shell + the
 * nonce-redeem step, so the deploy verifies and the bot can start
 * minting links into here. The actual passkey + sign flow lands in
 * the next commit.
 */
export default function SetupClient() {
  const params = useSearchParams();
  const nonce = params.get('t');
  const [status, setStatus] = useState<'idle' | 'redeeming' | 'ready' | 'error'>('idle');
  const [discordTag, setDiscordTag] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!nonce) {
      setStatus('error');
      setErrorMsg('Missing setup link. Open the link the bot DMed you in Discord — it includes a one-time token.');
      return;
    }
    setStatus('redeeming');
    fetch('/api/link/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, purpose: 'setup' }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `redeem failed (${r.status})`);
        setDiscordTag(body.discordTag || body.discordId);
        setStatus('ready');
      })
      .catch((err) => {
        setErrorMsg(err.message);
        setStatus('error');
      });
  }, [nonce]);

  if (status === 'idle' || status === 'redeeming') {
    return (
      <main>
        <h1>Setting up your wallet…</h1>
        <p className="muted">Verifying your link.</p>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main>
        <h1>Couldn&apos;t verify your link</h1>
        <p>{errorMsg}</p>
        <p className="muted">
          Open Discord and use the most recent setup link the bot sent you.
          Each link is valid for 10 minutes and works once.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Set up your Rank $ wallet</h1>
      <p>Signed in as <strong>{discordTag}</strong>.</p>

      <div className="card">
        <h2>Step 1 — Create your wallet</h2>
        <p>
          You&apos;re about to create your own crypto wallet on Base. It&apos;s
          locked by your phone or computer&apos;s built-in passkey
          (Face ID / Touch ID / Windows Hello / security key).
        </p>
        <p>
          <strong>Only you can sign with it. Rank $ never sees your passkey
          and can never move your funds without your permission.</strong>
        </p>
        {/* Wallet connect button lands in next commit */}
        <button className="btn" disabled>
          Create Wallet (coming next)
        </button>
      </div>

      <div className="card">
        <h2>Step 2 — Set your daily match limit</h2>
        <p>
          Pick the <strong>most you&apos;d ever want Rank $ to charge you in
          a single day</strong> for joining matches. Think of it like a daily
          debit-card limit you set yourself.
        </p>
        <p>
          <strong>You&apos;re not paying anything now.</strong> This just sets
          a cap so you don&apos;t need to approve every match individually.
          Rank $ can never charge more than your limit, and you can change or
          turn it off anytime.
        </p>
        <p className="muted">
          Pick whatever fits how you play:
        </p>
        <ul style={{ marginLeft: 20, marginBottom: 16 }}>
          <li><strong>$50/day</strong> — casual, a few small matches</li>
          <li><strong>$200/day</strong> — regular player</li>
          <li><strong>$1,000/day</strong> — high-stakes / tournament weekends</li>
        </ul>
        <p className="muted">Available after Step 1.</p>
      </div>

      <div className="card">
        <h2>What you can do later</h2>
        <p className="muted" style={{ marginBottom: 8 }}>
          • <strong>Withdraw</strong> — send your USDC anywhere, anytime, signed by your passkey.
        </p>
        <p className="muted" style={{ marginBottom: 8 }}>
          • <strong>Change your limit</strong> — raise it, lower it, or set it back to zero.
        </p>
        <p className="muted">
          • <strong>Revoke</strong> — turn off Rank $&apos;s ability to charge you entirely.
          Your wallet keeps working; the bot just can&apos;t pull funds anymore.
        </p>
      </div>
    </main>
  );
}

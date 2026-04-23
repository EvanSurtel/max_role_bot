'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Wallet setup flow.
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
export default function SetupPage() {
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
        <h2>Step 1 — Create your Coinbase Smart Wallet</h2>
        <p>
          You&apos;ll be asked to set up a passkey using Face ID, Touch ID,
          Windows Hello, or a security key. This passkey is what controls
          your wallet — Rank $ never sees it.
        </p>
        {/* Wallet connect button lands in next commit */}
        <button className="btn" disabled>
          Create Wallet (coming next)
        </button>
      </div>

      <div className="card">
        <h2>Step 2 — Approve in-app spending limit</h2>
        <p>
          You&apos;ll sign one permission letting the Rank $ bot pull up to
          a daily cap from your wallet (for joining matches). You can revoke
          this anytime.
        </p>
        <p className="muted">Available after Step 1.</p>
      </div>
    </main>
  );
}

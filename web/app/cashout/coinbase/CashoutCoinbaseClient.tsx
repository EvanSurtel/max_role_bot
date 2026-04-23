'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Coinbase Offramp bridge — client portion. Mirrors
 * DepositCoinbaseClient exactly; the only differences are the Next
 * API route called and the final redirect URL shape.
 */
export default function CashoutCoinbaseClient() {
  const params = useSearchParams();
  const nonce = params.get('t');
  const [status, setStatus] = useState<'minting' | 'ready' | 'error'>('minting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [offrampUrl, setOfframpUrl] = useState<string | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    if (!nonce) {
      setStatus('error');
      setErrorMsg('Missing link token. Open the most recent Coinbase cash-out link the bot sent you.');
      return;
    }

    fetch('/api/cashout/coinbase/mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `mint failed (${r.status})`);
        if (!body.offrampUrl) throw new Error('mint succeeded but no offrampUrl returned');
        setOfframpUrl(body.offrampUrl);
        setStatus('ready');
        window.location.href = body.offrampUrl;
      })
      .catch((err) => {
        setErrorMsg(err.message);
        setStatus('error');
      });
  }, [nonce]);

  if (status === 'minting') {
    return (
      <main>
        <h1>Preparing your Coinbase cash-out…</h1>
        <p className="muted">
          Generating a one-time cash-out link bound to your session.
        </p>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main>
        <h1>Couldn&apos;t open Coinbase</h1>
        <p>{errorMsg}</p>
        <p className="muted">
          Open Discord and click <strong>Cash Out</strong> again to get a fresh link.
          Each link works once and expires after 10 minutes.
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Continue on Coinbase</h1>
      <p>
        If your browser didn&apos;t redirect automatically, click the button below
        to open the Coinbase cash-out widget.
      </p>
      {offrampUrl && (
        <a className="btn" href={offrampUrl}>
          Continue to Coinbase
        </a>
      )}
    </main>
  );
}

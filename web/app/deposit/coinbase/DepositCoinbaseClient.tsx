'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Coinbase Onramp bridge — client portion.
 *
 * Runs in the user's browser, so any /api/deposit/coinbase/mint call we
 * make has access to the real user IP at the Vercel edge (forwarded
 * via x-forwarded-for) — that's what CDP requires on its session-token
 * POST. We don't ship clientIp from the browser ourselves; the API
 * route reads it from request headers server-side.
 *
 * Flow:
 *   1. Read nonce from ?t=
 *   2. POST {nonce} → /api/deposit/coinbase/mint
 *      The Next route forwards to bot's /api/internal/cdp/onramp/mint
 *      with the captured client IP attached.
 *   3. Receive { onrampUrl }, redirect window.location.
 *
 * If anything fails (link expired, CDP rejection, etc), surface a
 * clear message + a hint to go back to Discord and try again.
 */
export default function DepositCoinbaseClient() {
  const params = useSearchParams();
  const nonce = params.get('t');
  const [status, setStatus] = useState<'minting' | 'ready' | 'error'>('minting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [onrampUrl, setOnrampUrl] = useState<string | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    if (!nonce) {
      setStatus('error');
      setErrorMsg('Missing link token. Open the most recent Coinbase deposit link the bot sent you.');
      return;
    }

    fetch('/api/deposit/coinbase/mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `mint failed (${r.status})`);
        if (!body.onrampUrl) throw new Error('mint succeeded but no onrampUrl returned');
        setOnrampUrl(body.onrampUrl);
        setStatus('ready');
        // Auto-redirect — if the user's browser blocks the redirect
        // (popup blocker, etc), the visible "Continue to Coinbase"
        // button is the manual fallback.
        window.location.href = body.onrampUrl;
      })
      .catch((err) => {
        setErrorMsg(err.message);
        setStatus('error');
      });
  }, [nonce]);

  if (status === 'minting') {
    return (
      <main>
        <h1>Preparing your Coinbase checkout…</h1>
        <p className="muted">
          One moment — generating a one-time payment link bound to your session.
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
          Open Discord and click <strong>Deposit</strong> again to get a fresh link.
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
        to open the Coinbase Onramp widget.
      </p>
      {onrampUrl && (
        <a className="btn" href={onrampUrl}>
          Continue to Coinbase
        </a>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        You can close this tab once Coinbase opens.
      </p>
    </main>
  );
}

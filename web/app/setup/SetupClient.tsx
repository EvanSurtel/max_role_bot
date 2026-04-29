'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSignTypedData,
} from 'wagmi';
import { base } from 'wagmi/chains';

/**
 * Wallet setup flow — client portion.
 *
 * Full flow:
 *   1. Read one-time link nonce from ?t=... and POST it to /api/link/redeem
 *      to resolve to a Rank $ user id + Discord tag.
 *   2. User clicks "Create Wallet" → wagmi's Coinbase Wallet connector
 *      (pinned to smartWalletOnly in providers.tsx) triggers the
 *      Coinbase Smart Wallet passkey ceremony at keys.coinbase.com.
 *      On success we get back a Smart Wallet address (perm.account).
 *   3. User picks a daily match limit ($50 / $200 / $1000).
 *   4. We construct the EIP-712 SpendPermission struct (account=user
 *      Smart Wallet, spender=bot Smart Account, token=USDC, allowance=
 *      selected cap, period=86400s) and have the user sign it with
 *      their passkey via useSignTypedData.
 *   5. POST {userId, smartWalletAddress, permission, signature} to
 *      /api/wallet/grant → bot persists + lifts on-chain via
 *      approveWithSignature UserOp (gasless, Paymaster-sponsored).
 */

// Base mainnet addresses. These are constants, not env vars, because
// they're stable and picking the wrong one silently breaks the flow.
const SPEND_PERMISSION_MANAGER = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad' as const;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

// EIP-712 SpendPermission type — must match the SpendPermissionManager
// contract's hash domain exactly.
const SPEND_PERMISSION_TYPES = {
  SpendPermission: [
    { name: 'account', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'allowance', type: 'uint160' },
    { name: 'period', type: 'uint48' },
    { name: 'start', type: 'uint48' },
    { name: 'end', type: 'uint48' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraData', type: 'bytes' },
  ],
} as const;

type Status =
  | 'redeeming'
  | 'ready'            // link valid, waiting for wallet connect
  | 'connecting'       // passkey ceremony in flight
  | 'connected'        // wallet ready, waiting for user to pick limit
  | 'signing'          // EIP-712 sign prompt in flight
  | 'submitting'       // posting grant to /api/wallet/grant
  | 'done'
  | 'error';

type Limit = { usd: number; units: bigint; label: string };

const LIMIT_PRESETS: Limit[] = [
  { usd: 5, units: 5_000_000n, label: '$5 / day — try it out' },
  { usd: 20, units: 20_000_000n, label: '$20 / day — casual' },
  { usd: 50, units: 50_000_000n, label: '$50 / day — regular' },
  { usd: 200, units: 200_000_000n, label: '$200 / day — serious' },
  { usd: 1000, units: 1_000_000_000n, label: '$1,000 / day — tournament' },
];

function randomSalt(): bigint {
  // 32 random bytes → uint256. Uses Web Crypto, present in all modern
  // browsers + React Native WebView. Falls back to Math.random only if
  // crypto is somehow missing (shouldn't happen in a passkey-capable env).
  const arr = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  return BigInt('0x' + hex);
}

/**
 * `purpose` controls the link-redeem purpose + copy tweaks. 'setup' =
 * first-time wallet create; 'renew' = user already has a Smart Wallet
 * and we're collecting a fresh SpendPermission signature to replace
 * an expired/expiring one. Signing UX is identical; only labels and
 * the redeem purpose differ. The backend supersedes prior permissions
 * automatically when a new one lands in /api/wallet/grant.
 */
export default function SetupClient({ purpose = 'setup' }: { purpose?: 'setup' | 'renew' } = {}) {
  const params = useSearchParams();
  const nonce = params.get('t');
  const isRenew = purpose === 'renew';

  const [status, setStatus] = useState<Status>('redeeming');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [discordTag, setDiscordTag] = useState<string | null>(null);
  const [selectedLimit, setSelectedLimit] = useState<Limit | null>(null);
  const [resultTxHint, setResultTxHint] = useState<string | null>(null);
  // The nonce is kept live through the whole flow (just peeked on
  // load, not consumed) so a transient failure mid-flow — user
  // cancels passkey, network blip — doesn't burn the user's link.
  // The bot consumes it atomically when the grant lands.

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connectAsync, isPending: connectPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signTypedDataAsync } = useSignTypedData();

  const spender = process.env.NEXT_PUBLIC_BOT_SPENDER_ADDRESS;

  // Step 1 — redeem nonce on mount
  useEffect(() => {
    if (!nonce) {
      setStatus('error');
      setErrorMsg(
        isRenew
          ? 'Missing renewal link. Open the link the bot DMed you in Discord — it includes a one-time token.'
          : 'Missing setup link. Open the link the bot DMed you in Discord — it includes a one-time token.',
      );
      return;
    }
    fetch('/api/link/peek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, purpose }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `redeem failed (${r.status})`);
        setUserId(body.userId);
        setDiscordTag(body.discordTag || body.discordId);
        setStatus('ready');
      })
      .catch((err) => {
        setErrorMsg(err.message);
        setStatus('error');
      });
  }, [nonce, purpose, isRenew]);

  // Reflect wallet connection into our flow state
  useEffect(() => {
    if (isConnected && address && status === 'ready') {
      setStatus('connected');
    }
  }, [isConnected, address, status]);

  const connector = useMemo(
    () => connectors.find(c => c.id === 'coinbaseWalletSDK' || c.id === 'coinbaseWallet') ?? connectors[0],
    [connectors],
  );

  async function handleConnect() {
    if (!connector) {
      setErrorMsg('No Coinbase Wallet connector available. Refresh and try again.');
      setStatus('error');
      return;
    }
    setStatus('connecting');
    setErrorMsg(null);
    try {
      await connectAsync({ connector, chainId: base.id });
      // useEffect above flips status to 'connected' when useAccount updates
    } catch (err: any) {
      // User closing the passkey sheet shows up as a rejection — treat
      // as a soft reset back to 'ready' so they can try again.
      console.warn('connect failed', err);
      setErrorMsg(err?.shortMessage || err?.message || 'Wallet connect cancelled.');
      setStatus('ready');
    }
  }

  async function handleSignAndSubmit() {
    if (!address || !userId || !selectedLimit || !spender) {
      setErrorMsg(
        !spender
          ? 'Missing NEXT_PUBLIC_BOT_SPENDER_ADDRESS config. Contact support.'
          : 'Finish the previous steps first.',
      );
      setStatus('error');
      return;
    }

    setStatus('signing');
    setErrorMsg(null);

    const now = Math.floor(Date.now() / 1000);
    // Permission valid for 1 year. User can revoke anytime via the
    // wallet web surface; after expiry the bot DMs a renewal link.
    const end = now + 365 * 24 * 60 * 60;

    const permission = {
      account: address as `0x${string}`,
      spender: spender as `0x${string}`,
      token: USDC_BASE,
      allowance: selectedLimit.units,
      period: 24 * 60 * 60, // 1 day rolling window
      start: now,
      end,
      salt: randomSalt(),
      extraData: '0x' as `0x${string}`,
    };

    let signature: string;
    try {
      signature = await signTypedDataAsync({
        domain: {
          name: 'Spend Permission Manager',
          version: '1',
          chainId: base.id,
          verifyingContract: SPEND_PERMISSION_MANAGER,
        },
        types: SPEND_PERMISSION_TYPES as any,
        primaryType: 'SpendPermission',
        message: permission as any,
      });
    } catch (err: any) {
      console.warn('sign failed', err);
      setErrorMsg(err?.shortMessage || err?.message || 'Signature cancelled.');
      setStatus('connected');
      return;
    }

    setStatus('submitting');
    try {
      const r = await fetch('/api/wallet/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nonce,                 // consumed atomically on the bot side
          purpose,               // 'setup' | 'renew'
          userId,
          smartWalletAddress: address,
          permission: {
            ...permission,
            allowance: permission.allowance.toString(),
            salt: permission.salt.toString(),
          },
          signature,
        }),
      });
      const body = await r.json().catch(() => ({}));
      // 200 = approveOnChain landed synchronously, fully done.
      // 202 = grant persisted but on-chain step deferred (e.g. wallet
      //       lock contention); the bot's sweeper will finish it within
      //       ~60s. Show "done" but with a softer message.
      // 4xx/5xx = real failure; surface to user.
      if (r.status === 202) {
        setResultTxHint(
          body.permissionId
            ? `permission #${body.permissionId} — finishing up in the background (about 60 seconds)`
            : 'finishing up in the background (about 60 seconds)',
        );
        setStatus('done');
      } else if (!r.ok) {
        throw new Error(body.error || `grant failed (${r.status})`);
      } else {
        setResultTxHint(body.permissionId ? `permission #${body.permissionId}` : null);
        setStatus('done');
      }
    } catch (err: any) {
      setErrorMsg(err.message);
      setStatus('error');
    }
  }

  // ─── Render ─────────────────────────────────────────────────────

  if (status === 'redeeming') {
    return (
      <main>
        <h1>{isRenew ? 'Renewing your permission…' : 'Setting up your wallet…'}</h1>
        <p className="muted">Verifying your link.</p>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main>
        <h1>Something went wrong</h1>
        <p>{errorMsg}</p>
        <p className="muted">
          Open Discord and use the most recent {isRenew ? 'renewal' : 'setup'} link the bot sent you.
          Each link is valid for 10 minutes and works once.
        </p>
      </main>
    );
  }

  if (status === 'done') {
    return (
      <main>
        <h1>✅ You&apos;re all set</h1>
        <p>
          {isRenew
            ? 'Your new daily spending limit is active. The previous one has been replaced.'
            : 'Your self-custody wallet is live. Head back to Discord — your wallet panel will show the new address.'}
        </p>
        {resultTxHint && <p className="muted">{resultTxHint}</p>}
        <p className="muted">
          You can close this tab. If you ever want to change your daily
          spending limit, send funds out of your wallet, or turn the limit
          off entirely, use the buttons in your Rank $ wallet channel.
        </p>
      </main>
    );
  }

  const onWrongChain = isConnected && chainId !== base.id;

  return (
    <main>
      <h1>{isRenew ? 'Renew your daily spending limit' : 'Set up your Rank $ wallet'}</h1>
      {discordTag && (
        <p>
          Signed in as <strong>{discordTag}</strong>.
        </p>
      )}

      <div className="card">
        <h2>Step 1 — {isRenew ? 'Reconnect your wallet' : 'Create your wallet'}</h2>
        <p>
          {isRenew
            ? 'Reconnect the same Coinbase Smart Wallet you created during setup — the renewal has to be signed by the same passkey.'
            : 'You’re about to create your own crypto wallet on Base. It’s locked by your phone or computer’s built-in passkey (Face ID / Touch ID / Windows Hello / security key).'}
        </p>
        <p>
          <strong>
            Only you can sign with it. Rank $ never sees your passkey and can
            never move your funds without your permission.
          </strong>
        </p>

        {!isConnected ? (
          <button
            className="btn"
            onClick={handleConnect}
            disabled={status === 'connecting' || connectPending}
          >
            {status === 'connecting' || connectPending
              ? 'Opening passkey…'
              : isRenew ? 'Connect Wallet' : 'Create Wallet'}
          </button>
        ) : (
          <>
            <p className="muted" style={{ wordBreak: 'break-all' }}>
              Connected: <code>{address}</code>
            </p>
            {onWrongChain && (
              <p style={{ color: '#e74c3c' }}>
                Your wallet is on the wrong network. Switch to Base and
                reconnect.
              </p>
            )}
            <button
              className="btn btn-secondary"
              onClick={() => disconnectAsync().then(() => setStatus('ready'))}
            >
              Use a different wallet
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h2>Step 2 — Set your daily spending limit</h2>
        <p>
          Pick the <strong>most YOU want to spend on cash matches in a single
          day</strong>. Think of it as a daily budget you set for yourself —
          like a daily debit-card limit, except you&apos;re the one setting it.
        </p>
        <p>
          <strong>You&apos;re not paying anything now.</strong> This just sets
          a cap so you don&apos;t have to approve every match individually.
          Once it&apos;s set, joining a match within your daily cap is one click
          — and a match that would push you past your own cap simply won&apos;t
          go through. You can raise it, lower it, or turn it off anytime.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {LIMIT_PRESETS.map((l) => {
            const selected = selectedLimit?.usd === l.usd;
            return (
              <button
                key={l.usd}
                className={selected ? 'btn' : 'btn btn-secondary'}
                onClick={() => setSelectedLimit(l)}
                disabled={!isConnected || status === 'signing' || status === 'submitting'}
                style={{ textAlign: 'left' }}
              >
                {l.label}
              </button>
            );
          })}
        </div>

        <button
          className="btn"
          onClick={handleSignAndSubmit}
          disabled={
            !isConnected ||
            !selectedLimit ||
            onWrongChain ||
            status === 'signing' ||
            status === 'submitting'
          }
        >
          {status === 'signing'
            ? 'Waiting for passkey signature…'
            : status === 'submitting'
              ? 'Saving…'
              : 'Sign with passkey'}
        </button>

        {errorMsg && (status === 'connected' || status === 'ready') && (
          <p style={{ color: '#e74c3c', marginTop: 12 }}>{errorMsg}</p>
        )}
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

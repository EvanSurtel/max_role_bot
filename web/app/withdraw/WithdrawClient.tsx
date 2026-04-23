'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { base } from 'wagmi/chains';
import { isAddress, parseUnits, formatUnits } from 'viem';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

const USDC_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

type Status =
  | 'redeeming'       // validating one-time link
  | 'ready'           // link valid, waiting for wallet connect
  | 'connected'       // wallet connected, collecting destination + amount
  | 'confirming'      // waiting for passkey signature / userop submission
  | 'pending'         // tx submitted, waiting for receipt
  | 'done'
  | 'error';

export default function WithdrawClient() {
  const params = useSearchParams();
  const nonce = params.get('t');

  const [status, setStatus] = useState<Status>('redeeming');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [discordTag, setDiscordTag] = useState<string | null>(null);
  const [destination, setDestination] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connectAsync, isPending: connectPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { writeContractAsync } = useWriteContract();

  // Balance of connected Smart Wallet — canonical source for "how much
  // can the user withdraw". For smart-wallet users the on-chain USDC
  // balance is authoritative (no operator custody), so we show it
  // directly rather than the bot's DB view.
  const { data: balanceRaw, refetch: refetchBalance } = useReadContract({
    address: USDC_BASE,
    abi: USDC_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Wait-for-receipt after the user signs. Once the UserOp mines the
  // balance is effectively updated on-chain; we refetch to close the
  // loop in-page and flip to done.
  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
    query: { enabled: !!txHash },
  });

  useEffect(() => {
    if (receipt && status === 'pending') {
      setStatus('done');
      refetchBalance();
    }
  }, [receipt, status, refetchBalance]);

  // Step 1 — redeem nonce on mount
  useEffect(() => {
    if (!nonce) {
      setStatus('error');
      setErrorMsg('Missing withdrawal link. Open the link the bot DMed you in Discord.');
      return;
    }
    fetch('/api/link/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, purpose: 'withdraw' }),
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

  useEffect(() => {
    if (isConnected && address && status === 'ready') setStatus('connected');
  }, [isConnected, address, status]);

  const connector = useMemo(
    () => connectors.find(c => c.id === 'coinbaseWalletSDK' || c.id === 'coinbaseWallet') ?? connectors[0],
    [connectors],
  );

  async function handleConnect() {
    if (!connector) {
      setErrorMsg('No Coinbase Wallet connector available.');
      setStatus('error');
      return;
    }
    try {
      await connectAsync({ connector, chainId: base.id });
    } catch (err: any) {
      setErrorMsg(err?.shortMessage || err?.message || 'Wallet connect cancelled.');
    }
  }

  const balance = balanceRaw != null ? (balanceRaw as bigint) : 0n;
  const balanceDisplay = formatUnits(balance, 6);

  const amountValid = useMemo(() => {
    const cleaned = amountStr.trim();
    if (!cleaned) return null;
    try {
      const units = parseUnits(cleaned, 6);
      if (units <= 0n) return null;
      if (units > balance) return null;
      return units;
    } catch {
      return null;
    }
  }, [amountStr, balance]);

  const destinationValid = destination.trim() !== '' && isAddress(destination.trim());

  async function handleSend() {
    if (!destinationValid || !amountValid) return;
    setStatus('confirming');
    setErrorMsg(null);
    try {
      const hash = await writeContractAsync({
        address: USDC_BASE,
        abi: USDC_ABI,
        functionName: 'transfer',
        args: [destination.trim() as `0x${string}`, amountValid],
      });
      setTxHash(hash);
      setStatus('pending');
    } catch (err: any) {
      setErrorMsg(err?.shortMessage || err?.message || 'Signature cancelled or failed.');
      setStatus('connected');
    }
  }

  // ─── Render ─────────────────────────────────────────────────────

  if (status === 'redeeming') {
    return (
      <main>
        <h1>Preparing withdrawal…</h1>
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
          Open Discord and use the most recent withdrawal link the bot sent you.
          Each link is valid for 10 minutes and works once.
        </p>
      </main>
    );
  }

  if (status === 'done' && txHash) {
    return (
      <main>
        <h1>✅ Withdrawal sent</h1>
        <p>
          Your transfer is on-chain. It usually confirms in a few seconds on Base.
        </p>
        <p className="muted" style={{ wordBreak: 'break-all' }}>
          Tx: <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer"><code>{txHash}</code></a>
        </p>
        <p className="muted">You can close this tab.</p>
      </main>
    );
  }

  const onWrongChain = isConnected && chainId !== base.id;

  return (
    <main>
      <h1>Withdraw USDC</h1>
      {discordTag && (
        <p>
          Signed in as <strong>{discordTag}</strong>.
        </p>
      )}

      <div className="card">
        <h2>Step 1 — Connect your wallet</h2>
        <p>
          Connect the same Coinbase Smart Wallet you set up earlier. The
          withdrawal is signed by your passkey — Rank $ never touches it.
        </p>
        {!isConnected ? (
          <button className="btn" onClick={handleConnect} disabled={connectPending}>
            {connectPending ? 'Opening passkey…' : 'Connect Wallet'}
          </button>
        ) : (
          <>
            <p className="muted" style={{ wordBreak: 'break-all' }}>
              Connected: <code>{address}</code>
            </p>
            {onWrongChain && (
              <p style={{ color: '#e74c3c' }}>Switch your wallet to Base and reconnect.</p>
            )}
            <p className="muted">Available: <strong>${balanceDisplay} USDC</strong></p>
            <button className="btn btn-secondary" onClick={() => disconnectAsync()}>
              Use a different wallet
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h2>Step 2 — Where to send</h2>
        <p>
          Paste any Base address. USDC on Base only — do not send to an
          Ethereum-mainnet address; the funds won&apos;t arrive.
        </p>
        <input
          type="text"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="0x…"
          disabled={!isConnected || status === 'confirming' || status === 'pending'}
          style={{
            width: '100%',
            padding: '10px 12px',
            marginBottom: 12,
            borderRadius: 8,
            border: '1px solid #2a2f3a',
            background: '#0e1015',
            color: '#e6e8eb',
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 14,
          }}
        />
        {destination.trim() && !destinationValid && (
          <p style={{ color: '#e74c3c', marginBottom: 12 }}>
            That doesn&apos;t look like a valid address.
          </p>
        )}

        <h2 style={{ marginTop: 16 }}>Amount (USDC)</h2>
        <input
          type="text"
          inputMode="decimal"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          placeholder={balanceDisplay}
          disabled={!isConnected || status === 'confirming' || status === 'pending'}
          style={{
            width: '100%',
            padding: '10px 12px',
            marginBottom: 12,
            borderRadius: 8,
            border: '1px solid #2a2f3a',
            background: '#0e1015',
            color: '#e6e8eb',
            fontSize: 14,
          }}
        />
        {amountStr.trim() && !amountValid && (
          <p style={{ color: '#e74c3c', marginBottom: 12 }}>
            Enter an amount greater than 0 and no more than ${balanceDisplay}.
          </p>
        )}

        <button
          className="btn"
          onClick={handleSend}
          disabled={
            !isConnected ||
            !destinationValid ||
            !amountValid ||
            onWrongChain ||
            status === 'confirming' ||
            status === 'pending'
          }
        >
          {status === 'confirming'
            ? 'Waiting for passkey…'
            : status === 'pending'
              ? 'Broadcasting…'
              : 'Send USDC'}
        </button>

        {errorMsg && <p style={{ color: '#e74c3c', marginTop: 12 }}>{errorMsg}</p>}
      </div>

      <p className="muted">
        Tip: you can also withdraw directly from the Coinbase Wallet app — this
        page is just a convenience for doing it from Rank $.
      </p>
    </main>
  );
}

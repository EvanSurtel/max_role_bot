import { Suspense } from 'react';
import WithdrawClient from './WithdrawClient';

/**
 * /withdraw — smart-wallet user sends USDC out of their own Smart
 * Wallet. The bot can't sign this (the user owns the wallet via
 * passkey), so withdrawal happens entirely in-browser: connect, enter
 * destination + amount, sign a USDC.transfer UserOp with the passkey.
 *
 * Legacy CDP Server Wallet users don't see this page — they still
 * withdraw through the bot (wallet_type='cdp_server' in the DB keeps
 * the old Discord-button flow).
 */
export default function WithdrawPage() {
  return (
    <Suspense
      fallback={
        <main>
          <h1>Loading…</h1>
        </main>
      }
    >
      <WithdrawClient />
    </Suspense>
  );
}

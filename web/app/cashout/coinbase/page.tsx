import { Suspense } from 'react';
import CashoutCoinbaseClient from './CashoutCoinbaseClient';

/**
 * /cashout/coinbase — bridge page between Discord and the Coinbase
 * Offramp widget. Parallels /deposit/coinbase: capture real user IP
 * at the Vercel edge so the CDP session-token POST carries a valid
 * clientIp, which CDP requires so only the originating viewer can
 * redeem the resulting widget URL.
 */
export default function CashoutCoinbasePage() {
  return (
    <Suspense
      fallback={
        <main>
          <h1>Preparing your Coinbase cash-out…</h1>
        </main>
      }
    >
      <CashoutCoinbaseClient />
    </Suspense>
  );
}

import { Suspense } from 'react';
import DepositCoinbaseClient from './DepositCoinbaseClient';

/**
 * /deposit/coinbase
 *
 * Bridge page between Discord and the Coinbase Onramp widget.
 *
 * Why this page exists: CDP requires the originating user's clientIp
 * on the Onramp session-token request. The Discord bot can't see a
 * real user IP — every interaction reaches it through Discord's edge
 * proxies. So instead the bot DMs the user a one-time link to here;
 * this page captures the user's IP from the request, forwards it to
 * the bot's internal mint endpoint along with the nonce, and uses the
 * resulting onramp URL to redirect the user into Coinbase.
 *
 * The Suspense wrapper is required by Next.js 15 around any client
 * component that reads useSearchParams.
 */
export default function DepositCoinbasePage() {
  return (
    <Suspense
      fallback={
        <main>
          <h1>Preparing your Coinbase checkout…</h1>
        </main>
      }
    >
      <DepositCoinbaseClient />
    </Suspense>
  );
}

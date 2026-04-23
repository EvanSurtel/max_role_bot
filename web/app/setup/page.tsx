import { Suspense } from 'react';
import SetupClient from './SetupClient';

/**
 * Server-component wrapper that satisfies Next.js 15's strict
 * Suspense requirement around client hooks (useSearchParams).
 * The actual UI lives in SetupClient.tsx.
 */
export default function SetupPage() {
  return (
    <Suspense
      fallback={
        <main>
          <h1>Loading…</h1>
        </main>
      }
    >
      <SetupClient />
    </Suspense>
  );
}

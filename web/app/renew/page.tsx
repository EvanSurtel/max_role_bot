import { Suspense } from 'react';
import SetupClient from '../setup/SetupClient';

/**
 * /renew — user's SpendPermission has expired (or is about to expire)
 * and the bot has DMed them a fresh one-time link to sign a new one.
 *
 * Reuses the full setup flow component with purpose='renew'. The only
 * behavioral difference is the link-redeem purpose check; backend-side,
 * a successful grant supersedes any existing permission for this user
 * automatically (see spendPermissionRepo.markApprovedAndSupersedeOthers).
 */
export default function RenewPage() {
  return (
    <Suspense
      fallback={
        <main>
          <h1>Loading…</h1>
        </main>
      }
    >
      <SetupClient purpose="renew" />
    </Suspense>
  );
}

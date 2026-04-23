/**
 * GET /api/health — sanity check for Vercel deploys.
 * Returns 200 with current commit SHA (when set) so a quick curl
 * against rank-wallet.vercel.app/api/health confirms the deploy is
 * live and identifies which build is serving.
 */
export async function GET() {
  return Response.json({
    ok: true,
    service: 'rank-wallet-web',
    commit: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    timestamp: new Date().toISOString(),
  });
}

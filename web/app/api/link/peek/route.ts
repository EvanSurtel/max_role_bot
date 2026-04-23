import { NextRequest } from 'next/server';

/**
 * POST /api/link/peek
 *
 * Non-consuming lookup of a one-time link nonce. Used by /setup and
 * /renew on page load so the UI can render "signed in as X" without
 * burning the nonce — if the user cancels the passkey prompt, closes
 * the tab, or the network blips, the link is still valid for a retry.
 * The grant endpoint (/api/wallet/grant) is what actually consumes
 * the nonce, atomically with the DB write.
 *
 * Body: { nonce: string, purpose: 'setup' | 'renew' | 'withdraw' }
 * Response: { userId, discordId, discordTag } or { error }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.nonce || !body?.purpose) {
    return Response.json({ error: 'nonce and purpose required' }, { status: 400 });
  }

  const baseUrl = process.env.BOT_API_BASE_URL;
  const secret = process.env.BOT_API_SHARED_SECRET;
  if (!baseUrl || !secret) {
    return Response.json(
      { error: 'BOT_API_BASE_URL and BOT_API_SHARED_SECRET must be set' },
      { status: 500 },
    );
  }

  try {
    const upstream = await fetch(`${baseUrl}/api/internal/link/peek`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify({ nonce: body.nonce, purpose: body.purpose }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await upstream.json().catch(() => ({}));
    return Response.json(data, { status: upstream.status });
  } catch (err: any) {
    return Response.json(
      { error: `bot api call failed: ${err.message}` },
      { status: 502 },
    );
  }
}

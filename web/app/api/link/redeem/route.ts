import { NextRequest } from 'next/server';

/**
 * POST /api/link/redeem
 *
 * Validates a one-time link nonce that the Discord bot DMed to a user
 * and returns the corresponding Discord ID + tag. The browser uses the
 * Discord identity to bind the about-to-be-created Smart Wallet to the
 * right Rank $ account.
 *
 * Implementation pattern: this Next.js route proxies to the bot's
 * internal API (BOT_API_BASE_URL + /api/internal/link/redeem) using a
 * shared secret in the X-Internal-Secret header so a random caller
 * can't poke the bot's nonce store directly. The bot is the source of
 * truth for nonce TTL + single-use enforcement.
 *
 * Body: { nonce: string, purpose: 'setup' | 'withdraw' | 'renew' }
 * Response: { discordId, discordTag } or { error }
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
    const upstream = await fetch(`${baseUrl}/api/internal/link/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify({ nonce: body.nonce, purpose: body.purpose }),
      // Vercel kills long-running serverless functions; cap upstream
      // call at 10s — the bot should respond in <100ms for a DB lookup.
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

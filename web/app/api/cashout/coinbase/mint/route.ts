import { NextRequest } from 'next/server';

/**
 * POST /api/cashout/coinbase/mint — parallel to /api/deposit/coinbase/mint.
 * Captures the real user IP at the Vercel edge, forwards {nonce, clientIp}
 * to the bot's /api/internal/cdp/offramp/mint, returns the offramp URL.
 */

function extractClientIp(req: NextRequest): string | null {
  // See deposit/coinbase/mint/route.ts for the full reasoning. In
  // short: x-forwarded-for's leftmost entry is browser-controlled on
  // Vercel and MUST NOT be trusted. Prefer x-real-ip /
  // x-vercel-forwarded-for which Vercel sets to the verified source IP.
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();

  const vercelFF = req.headers.get('x-vercel-forwarded-for');
  if (vercelFF && vercelFF.trim()) {
    const first = vercelFF.split(',')[0].trim();
    if (first) return first;
  }

  const cf = req.headers.get('cf-connecting-ip');
  if (cf && cf.trim()) return cf.trim();

  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.nonce) {
    return Response.json({ error: 'nonce required' }, { status: 400 });
  }

  const clientIp = extractClientIp(req);
  if (!clientIp) {
    return Response.json(
      { error: 'could not determine client IP from request headers' },
      { status: 400 },
    );
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
    const upstream = await fetch(`${baseUrl}/api/internal/cdp/offramp/mint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify({ nonce: body.nonce, clientIp }),
      signal: AbortSignal.timeout(15_000),
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

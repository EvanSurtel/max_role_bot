import { NextRequest } from 'next/server';

/**
 * POST /api/deposit/coinbase/mint
 *
 * Server-side step in the Coinbase Onramp bridge flow. Captures the
 * end user's IP from the incoming request headers (Vercel forwards it
 * via x-forwarded-for / x-real-ip) and forwards {nonce, clientIp} to
 * the Discord bot's internal /api/internal/cdp/onramp/mint endpoint
 * over a shared-secret-authed channel.
 *
 * The bot redeems the nonce, mints a CDP one-click-buy session WITH
 * clientIp included in the body, and returns the resulting onrampUrl.
 * CDP requires clientIp on the session-token POST so the resulting
 * widget URL is bound to the originating viewer (a quote can only be
 * redeemed from the IP that requested it).
 *
 * IP precedence:
 *   1. x-forwarded-for (first hop)  — Vercel sets this
 *   2. x-real-ip                    — fallback for proxies
 *   3. cf-connecting-ip             — if fronted by Cloudflare
 *   4. nothing                      — refuse to call CDP without IP
 *
 * We never trust a clientIp value posted from the browser body — only
 * the headers attached by the platform.
 */

function extractClientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    // x-forwarded-for is a comma-separated chain "client, proxy1, proxy2".
    // The leftmost entry is the original client. Trim and validate.
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  const xri = req.headers.get('x-real-ip');
  if (xri) return xri.trim();
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
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
    const upstream = await fetch(`${baseUrl}/api/internal/cdp/onramp/mint`, {
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

import { NextRequest } from 'next/server';

/**
 * POST /api/wallet/grant
 *
 * Receives the signed SpendPermission from the browser and proxies it
 * to the Discord bot's internal endpoint. The bot persists the grant,
 * binds the user's Smart Wallet address to their Rank $ account, and
 * kicks off the on-chain approveWithSignature UserOp in the background.
 *
 * Body: {
 *   userId: number,          // Rank $ internal user id (from /api/link/redeem)
 *   smartWalletAddress: string,
 *   permission: {
 *     account, spender, token, allowance, period, start, end, salt, extraData
 *   },
 *   signature: string,       // user's EIP-712 signature (may be ERC-6492 wrapped)
 * }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.userId || !body?.smartWalletAddress || !body?.permission || !body?.signature) {
    return Response.json(
      { error: 'userId, smartWalletAddress, permission, signature required' },
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
    const upstream = await fetch(`${baseUrl}/api/internal/wallet/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify(body),
      // The bot's /grant endpoint persists synchronously and kicks off
      // the on-chain approve in the background, so upstream should be
      // fast (<500ms). 15s ceiling leaves headroom for cold SQLite.
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

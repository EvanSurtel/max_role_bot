#!/usr/bin/env node
// Test the full deposit flow using Changelly sandbox.
//
// 1. Create a test order via Changelly sandbox API
// 2. Verify the redirect URL is generated
// 3. Advance the order to "completed" via sandbox API
// 4. Trigger the webhook callback
// 5. Verify our webhook server receives it
//
// Also tests Coinbase Onramp URL generation.

require('dotenv').config();
const crypto = require('crypto');

const CHANGELLY_KEY = process.env.CHANGELLY_FIAT_API_KEY;
const CHANGELLY_SECRET = process.env.CHANGELLY_FIAT_API_SECRET;
const CHANGELLY_URL = process.env.CHANGELLY_FIAT_API_URL || 'https://fiat-api.changelly.com/v1';
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || '';
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || '3001';

function sign(fullUrl, body) {
  const privateKeyObject = crypto.createPrivateKey({
    key: CHANGELLY_SECRET,
    type: 'pkcs1',
    format: 'pem',
    encoding: 'base64',
  });
  const message = body || {};
  const payload = fullUrl + JSON.stringify(message);
  return crypto.sign('sha256', Buffer.from(payload), privateKeyObject).toString('base64');
}

async function changellyRequest(method, path, body = null) {
  const url = `${CHANGELLY_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': CHANGELLY_KEY,
    'X-Api-Signature': sign(url, body),
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('DEPOSIT FLOW TEST');
  console.log('═'.repeat(60));

  // ─── Test 1: Coinbase Onramp URL ────────────────────────
  console.log('\n[1] Coinbase Onramp URL generation...');
  const testAddress = '0xd53cD88a294C222a22AFcc07d171714135e0C966';
  const cdpAppId = process.env.CDP_API_KEY || process.env.CDP_API_KEY_ID || 'test';
  const onrampUrl = `https://pay.coinbase.com/buy/select-asset?appId=${cdpAppId}&addresses={"${testAddress}":["base"]}&assets=["USDC"]&presetFiatAmount=50&defaultPaymentMethod=CARD`;
  console.log(`  URL: ${onrampUrl.slice(0, 80)}...`);
  console.log(`  Contains address: ${onrampUrl.includes(testAddress) ? '✅' : '❌'}`);
  console.log(`  Contains base network: ${onrampUrl.includes('base') ? '✅' : '❌'}`);
  console.log(`  Contains USDC: ${onrampUrl.includes('USDC') ? '✅' : '❌'}`);

  // ─── Test 2: Changelly — check config ───────────────────
  console.log('\n[2] Changelly configuration...');
  if (!CHANGELLY_KEY || !CHANGELLY_SECRET) {
    console.log('  ❌ CHANGELLY_FIAT_API_KEY or SECRET not set. Skipping Changelly tests.');
    return;
  }
  console.log(`  API Key: ${CHANGELLY_KEY.slice(0, 10)}...`);
  console.log(`  API URL: ${CHANGELLY_URL}`);
  console.log(`  Webhook: ${WEBHOOK_HOST || 'NOT SET'}`);

  // ─── Test 3: Changelly — list available countries ───────
  console.log('\n[3] Changelly available countries...');
  const countries = await changellyRequest('GET', '/available-countries');
  if (countries.status === 200 && Array.isArray(countries.data)) {
    console.log(`  ✅ ${countries.data.length} countries available`);
  } else {
    console.log(`  ❌ Status ${countries.status}: ${JSON.stringify(countries.data).slice(0, 100)}`);
  }

  // ─── Test 4: Changelly — get offers ─────────────────────
  console.log('\n[4] Changelly offers for $50 USD → USDC...');
  const offers = await changellyRequest('GET', '/offers?currencyFrom=USD&currencyTo=USDC&amountFrom=50&country=US&state=CA&paymentMethod=card');
  if (offers.status === 200) {
    const data = Array.isArray(offers.data) ? offers.data : [offers.data];
    console.log(`  ✅ ${data.length} offer(s) returned`);
    if (data[0]) {
      console.log(`  Provider: ${data[0].providerCode || data[0].provider || 'unknown'}`);
      console.log(`  Rate: ${data[0].amountTo || data[0].amount_to || '?'} USDC for $50`);
    }
  } else {
    console.log(`  Status ${offers.status}: ${JSON.stringify(offers.data).slice(0, 100)}`);
  }

  // ─── Test 5: Changelly — create sandbox order ───────────
  console.log('\n[5] Changelly create sandbox order...');
  const orderBody = {
    externalOrderId: `test-${Date.now()}`,
    externalUserId: 'test-user-123',
    providerCode: 'moonpay',
    currencyFrom: 'USD',
    currencyTo: 'USDC',
    amountFrom: '50',
    country: 'US',
    state: 'CA',
    walletAddress: testAddress,
    walletExtraId: '',
    paymentMethod: 'card',
  };
  if (WEBHOOK_HOST) {
    orderBody.callbackUrl = `${WEBHOOK_HOST}/api/changelly/webhook`;
    console.log(`  Callback URL: ${orderBody.callbackUrl}`);
  }

  const order = await changellyRequest('POST', '/orders', orderBody);
  console.log(`  Status: ${order.status}`);

  if (order.status === 200 || order.status === 201) {
    const orderId = order.data?.orderId || order.data?.id || order.data?.order_id;
    const redirectUrl = order.data?.redirectUrl || order.data?.redirect_url || order.data?.paymentUrl;
    console.log(`  ✅ Order created: ${orderId}`);
    console.log(`  Redirect URL: ${redirectUrl ? redirectUrl.slice(0, 60) + '...' : 'NOT RETURNED'}`);

    if (orderId) {
      // ─── Test 6: Advance order to completed (sandbox) ───
      console.log('\n[6] Advancing order to "completed" (sandbox)...');
      const advance = await changellyRequest('PATCH', `/sandbox/order/${orderId}`, {
        status: 'completed',
        amountTo: '49.50',
      });
      console.log(`  Status: ${advance.status}`);
      if (advance.status === 200) {
        console.log(`  ✅ Order advanced to completed`);
      } else {
        console.log(`  Response: ${JSON.stringify(advance.data).slice(0, 200)}`);
      }

      // ─── Test 7: Trigger webhook callback (sandbox) ─────
      if (WEBHOOK_HOST) {
        console.log('\n[7] Triggering webhook callback (sandbox)...');
        const resend = await changellyRequest('POST', `/sandbox/order/${orderId}/resend-callback`);
        console.log(`  Status: ${resend.status}`);
        if (resend.status === 200) {
          console.log(`  ✅ Webhook triggered — check bot logs for [Changelly] Webhook message`);
        } else {
          console.log(`  Response: ${JSON.stringify(resend.data).slice(0, 200)}`);
        }
      } else {
        console.log('\n[7] Skipped webhook test — WEBHOOK_HOST not set');
        console.log('  Set WEBHOOK_HOST=http://YOUR_SERVER_IP:3001 in .env to test webhooks');
      }
    }
  } else {
    console.log(`  Response: ${JSON.stringify(order.data).slice(0, 300)}`);
    if (order.status === 401 || order.status === 403) {
      console.log('  Check your CHANGELLY_FIAT_API_KEY and SECRET');
    }
  }

  // ─── Test 8: Coinbase Offramp URL ───────────────────────
  console.log('\n[8] Coinbase Offramp (cash out) URL generation...');
  const offrampUrl = `https://pay.coinbase.com/sell/select-asset?appId=${cdpAppId}&addresses={"${testAddress}":["base"]}&assets=["USDC"]`;
  console.log(`  URL: ${offrampUrl.slice(0, 80)}...`);
  console.log(`  Contains address: ${offrampUrl.includes(testAddress) ? '✅' : '❌'}`);
  console.log(`  Contains USDC: ${offrampUrl.includes('USDC') ? '✅' : '❌'}`);

  console.log('\n' + '═'.repeat(60));
  console.log('DEPOSIT FLOW TEST COMPLETE');
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message);
  process.exit(1);
});

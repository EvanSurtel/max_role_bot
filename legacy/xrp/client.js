const xrpl = require('xrpl');

const NETWORKS = {
  testnet: 'wss://s.altnet.rippletest.net:51233',
  mainnet: 'wss://xrplcluster.com',
};

/** @type {xrpl.Client | null} */
let client = null;
let reconnecting = false;

/**
 * Get the WebSocket URL based on XRPL_NETWORK env var.
 * Defaults to testnet if not set.
 */
function getServerUrl() {
  const network = (process.env.XRPL_NETWORK || 'testnet').toLowerCase();
  const url = NETWORKS[network];
  if (!url) {
    throw new Error(`Unknown XRPL_NETWORK: "${network}". Use "testnet" or "mainnet".`);
  }
  return url;
}

/**
 * Connect to the XRPL WebSocket server.
 * Returns the connected client. If already connected, returns the existing client.
 */
async function connect() {
  if (client && client.isConnected()) {
    return client;
  }

  const url = getServerUrl();
  client = new xrpl.Client(url);

  // Set up auto-reconnect on disconnect
  client.on('disconnected', (code) => {
    console.log(`[XRPL] Disconnected from ${url} (code: ${code})`);
    handleReconnect();
  });

  client.on('error', (error) => {
    console.error('[XRPL] Client error:', error.message || error);
  });

  console.log(`[XRPL] Connecting to ${url}...`);
  await client.connect();
  console.log(`[XRPL] Connected to ${url}`);

  return client;
}

/**
 * Handle automatic reconnection with exponential backoff.
 */
async function handleReconnect() {
  if (reconnecting) return;
  reconnecting = true;

  const maxRetries = 10;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    console.log(`[XRPL] Reconnect attempt ${attempt}/${maxRetries} in ${delay}ms...`);

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      if (client && !client.isConnected()) {
        await client.connect();
        console.log('[XRPL] Reconnected successfully');
        reconnecting = false;
        return;
      }
      // Already reconnected (e.g. by another call)
      reconnecting = false;
      return;
    } catch (err) {
      console.error(`[XRPL] Reconnect attempt ${attempt} failed:`, err.message || err);
    }
  }

  reconnecting = false;
  console.error('[XRPL] All reconnect attempts exhausted. Manual reconnect required.');
}

/**
 * Disconnect from the XRPL WebSocket server.
 */
async function disconnect() {
  if (client) {
    try {
      await client.disconnect();
      console.log('[XRPL] Disconnected');
    } catch (err) {
      console.error('[XRPL] Error during disconnect:', err.message || err);
    }
    client = null;
    reconnecting = false;
  }
}

/**
 * Get the connected XRPL client.
 * Throws if not connected.
 * @returns {xrpl.Client}
 */
function getClient() {
  if (!client || !client.isConnected()) {
    throw new Error('XRPL client is not connected. Call connect() first.');
  }
  return client;
}

module.exports = { connect, disconnect, getClient };

#!/usr/bin/env node
/* eslint-disable no-console */
// Admin: reset the CDP trial counter to 0.
//
// Run after Coinbase approves the Onramp full-access upgrade (at which
// point the trial cap is either lifted or bumped to a large number).
// Resetting here lets the payment router start handing out CDP options
// again immediately.
//
// Usage:
//   node scripts/reset-cdp-trial.js
//
// After running this, also remember to update .env:
//   - Bump CDP_TRIAL_MAX_TRANSACTIONS=999999999 (or remove the check)
//   - Flip CDP_OFFRAMP_ENABLED=true if offramp approval also came through
//   - Flip CDP_ZERO_FEE_USDC=true if zero-fee USDC approval came through
// Then restart the bot: `pm2 restart wager-bot`.

require('dotenv').config();

function main() {
  const cdpTrial = require('../src/services/cdpTrialService');
  const before = cdpTrial.getStatus();
  console.log(`[ResetCdpTrial] Before: ${JSON.stringify(before)}`);
  cdpTrial.reset();
  const after = cdpTrial.getStatus();
  console.log(`[ResetCdpTrial] After:  ${JSON.stringify(after)}`);
  console.log('');
  console.log('Done. Reminders:');
  console.log('  - Bump CDP_TRIAL_MAX_TRANSACTIONS in .env if Coinbase raised your limit.');
  console.log('  - Flip CDP_OFFRAMP_ENABLED=true if offramp approval arrived.');
  console.log('  - Flip CDP_ZERO_FEE_USDC=true if zero-fee USDC approval arrived.');
  console.log('  - Restart the bot: pm2 restart wager-bot');
  process.exit(0);
}

main();

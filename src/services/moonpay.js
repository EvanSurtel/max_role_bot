// Stub — MoonPay removed. Returns false for all config checks so
// the MoonPay wallet buttons never render.
module.exports = {
  isConfigured: () => false,
  isOfframpConfigured: () => false,
  getEnvLabel: () => 'disabled',
};

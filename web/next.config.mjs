// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The Coinbase Smart Wallet SDK + viem use modern ESM-only deps that
  // need transpiling via Next's SWC. transpilePackages lets us pull
  // them in without "Cannot use import statement outside a module"
  // errors at build time on Vercel.
  transpilePackages: ['@coinbase/wallet-sdk', '@coinbase/onchainkit', 'wagmi', 'viem'],

  // Pin Vercel's Node runtime; passkey / WebAuthn flows use Web Crypto
  // APIs that are only stable in Node 20+ on the server side.
  experimental: {
    serverActions: { bodySizeLimit: '1mb' },
  },

  async headers() {
    return [
      {
        // Lock down the entire site against being framed by anyone
        // except Discord — keeps a malicious site from embedding the
        // wallet flow inside a fake Rank $ skin to harvest signatures.
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // WebAuthn / passkey API requires explicit Permissions-Policy
          // grant. publickey-credentials-create + -get cover both
          // registration and assertion ceremonies.
          { key: 'Permissions-Policy', value: 'publickey-credentials-create=(self), publickey-credentials-get=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;

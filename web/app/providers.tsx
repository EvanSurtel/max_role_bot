'use client';

import { OnchainKitProvider } from '@coinbase/onchainkit';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { coinbaseWallet } from 'wagmi/connectors';
import { base } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * Wagmi + OnchainKit + react-query providers.
 *
 * The wagmi config pins Base mainnet only and forces the Coinbase
 * Smart Wallet ("smartWalletOnly" preference) — we don't want EOA
 * wallets like MetaMask in this flow because the whole architecture
 * assumes the user signs via passkey on a Coinbase Smart Wallet that
 * the bot's spender address has a SpendPermission against.
 */

const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    coinbaseWallet({
      appName: 'Rank $',
      preference: 'smartWalletOnly',
    }),
  ],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'),
  },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          chain={base}
          projectId={process.env.NEXT_PUBLIC_CDP_PROJECT_ID}
        >
          {children}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

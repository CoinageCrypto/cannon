'use client';
import { theme } from '@/theme/theme';
import { CacheProvider } from '@chakra-ui/next-js';
import { ChakraProvider } from '@chakra-ui/react';
import { ReactNode } from 'react';
import apolloClient from '@/graphql/ApolloClient';
import { ApolloProvider } from '@apollo/client';
import WalletProvider from '@/app/walletProvider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <CacheProvider>
      <ChakraProvider theme={theme}>
        <ApolloProvider client={apolloClient}>
          <WalletProvider>{children}</WalletProvider>
        </ApolloProvider>
      </ChakraProvider>
    </CacheProvider>
  );
}
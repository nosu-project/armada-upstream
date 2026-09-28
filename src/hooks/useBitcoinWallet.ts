import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useEsploraApis } from '@/hooks/useEsploraApis';
import { nostrPubkeyToBitcoinAddress, fetchAddressData, fetchBtcPrice, fetchTransactions } from '@/lib/bitcoin';

interface UseBitcoinWalletOptions {
  /**
   * Whether to hit the network. Always-mounted hidden UIs must pass visibility, or
   * polling contacts a third-party Esplora backend all session.
   */
  enabled?: boolean;
}

/** Derive the user's Taproot address from their pubkey and fetch balance + history from Esplora. */
export function useBitcoinWallet({ enabled = true }: UseBitcoinWalletOptions = {}) {
  const { user } = useCurrentUser();
  const esploraApis = useEsploraApis();

  const bitcoinAddress = useMemo(() => {
    if (!user) return '';
    return nostrPubkeyToBitcoinAddress(user.pubkey);
  }, [user]);

  const active = enabled && !!bitcoinAddress;

  const {
    data: addressData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['bitcoin-balance', esploraApis, bitcoinAddress],
    queryFn: ({ signal }) => fetchAddressData(bitcoinAddress, esploraApis, signal),
    enabled: active,
    refetchInterval: active ? 30_000 : false,
    refetchIntervalInBackground: false,
  });

  const { data: btcPrice } = useQuery({
    queryKey: ['btc-price', esploraApis],
    queryFn: ({ signal }) => fetchBtcPrice(esploraApis, signal),
    // Mempool.space's price feed refreshes about once a minute.
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });

  const {
    data: transactions,
    isLoading: isLoadingTxs,
  } = useQuery({
    queryKey: ['bitcoin-txs', esploraApis, bitcoinAddress],
    queryFn: ({ signal }) => fetchTransactions(bitcoinAddress, esploraApis, signal),
    enabled: active,
    refetchInterval: active ? 30_000 : false,
    refetchIntervalInBackground: false,
  });

  return {
    bitcoinAddress,
    /** Balance and transaction data (undefined while loading). */
    addressData,
    btcPrice,
    transactions,
    isLoading,
    isLoadingTxs,
    error,
    refetch,
    pubkey: user?.pubkey ?? '',
  };
}

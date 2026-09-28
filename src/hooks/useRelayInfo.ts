import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { KvPrefixCache } from '@/lib/db/kvCache';

export interface RelayInfoDocument {
  name?: string;
  description?: string;
  icon?: string;
  banner?: string;
  pubkey?: string;
  /** NIP-29: the relay's own pubkey, which signs group metadata. */
  self?: string;
  contact?: string;
  software?: string;
  version?: string;
  supported_nips?: number[];
  /** Buzz relays: custom protocol extensions (e.g. "nip-er", "nip-pl"). */
  supported_extensions?: string[];
  /**
   * NIP-AB pairing rendezvous. On `software: "newlay"` it marks Buzz compatibility mode — see
   * `isBuzzRelayInfo`.
   */
  pairing_relay_url?: string;
  auth_required?: boolean;
  payment_required?: boolean;
  limitation?: {
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
  };
  fees?: {
    admission?: { amount: number; unit: string }[];
    subscription?: { amount: number; unit: string; period?: number }[];
  };
}

function relayToHttpUrl(relayUrl: string): string | null {
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// Disk-backed last-known-good NIP-11 docs so an offline reload still shows the real server
// name/avatar. In ArmadaDB KV (unbounded entries); the sync cache in front keeps `initialData` sync.
export const relayInfoCache = new KvPrefixCache<RelayInfoDocument>({ prefix: 'relay-info:' });

function readCachedInfo(relayUrl: string | undefined): RelayInfoDocument | undefined {
  return relayUrl ? relayInfoCache.get(relayUrl) : undefined;
}

function writeCachedInfo(relayUrl: string, info: RelayInfoDocument): void {
  relayInfoCache.set(relayUrl, info);
}

/**
 * Direct NIP-11 fetch, so useRelayGroups can get the signing key without gating on this
 * hook's query. Persists the last-known-good doc.
 */
export async function fetchRelayInfoDoc(
  relayUrl: string,
  signal?: AbortSignal,
): Promise<RelayInfoDocument> {
  const httpUrl = relayToHttpUrl(relayUrl);
  if (!httpUrl) {
    throw new Error('Invalid relay URL');
  }

  const signals = [AbortSignal.timeout(8000), ...(signal ? [signal] : [])];
  const response = await fetch(httpUrl, {
    headers: { Accept: 'application/nostr+json' },
    signal: AbortSignal.any(signals),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid NIP-11 response');
  }

  const info = payload as RelayInfoDocument;
  writeCachedInfo(relayUrl, info);
  return info;
}

export function useRelayInfo(relayUrl: string | undefined) {
  const httpUrl = relayUrl ? relayToHttpUrl(relayUrl) : null;
  const queryClient = useQueryClient();

  // The seed loads asynchronously; hand it to queries still without data once warm.
  useEffect(() => {
    if (!relayUrl || !httpUrl) return;
    let cancelled = false;
    void relayInfoCache.ready().then(() => {
      if (cancelled) return;
      const cached = readCachedInfo(relayUrl);
      if (!cached) return;
      const key = ['relay-info', relayUrl];
      if (queryClient.getQueryData<RelayInfoDocument>(key) === undefined) {
        queryClient.setQueryData(key, cached);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [relayUrl, httpUrl, queryClient]);

  return useQuery<RelayInfoDocument>({
    queryKey: ['relay-info', relayUrl],
    queryFn: ({ signal }) => fetchRelayInfoDoc(relayUrl!, signal),
    enabled: !!httpUrl,
    // Seed as a real success so a fetch failure never blanks it; `initialDataUpdatedAt: 0` still
    // triggers one background refresh.
    initialData: () => readCachedInfo(relayUrl),
    initialDataUpdatedAt: 0,
    staleTime: 12 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}


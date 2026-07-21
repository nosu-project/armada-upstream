import { useQuery } from '@tanstack/react-query';

export interface RelayInfoDocument {
  name?: string;
  description?: string;
  icon?: string;
  banner?: string;
  pubkey?: string;
  /** NIP-29: the relay's own keypair pubkey, which signs group metadata events. */
  self?: string;
  contact?: string;
  software?: string;
  version?: string;
  supported_nips?: number[];
  /** Buzz relays: custom protocol extensions (e.g. "nip-er", "nip-pl"). */
  supported_extensions?: string[];
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

/** Convert relay websocket URL to HTTP URL for NIP-11 requests. */
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

// A relay's NIP-11 doc (name, icon, banner, self key) is one of the most STABLE
// things about a server — it changes almost never. So we persist the last
// known-good doc to localStorage, keyed by relay URL, and seed the query with
// it. That way a reload over a shaky/offline connection still shows the real
// server name and avatar instead of collapsing to the bare host + a placeholder
// logo while the NIP-11 fetch fails. (react-query's cache is memory-only and
// vanishes on reload; this is the disk-backed last-known-good.)
const STORAGE_PREFIX = 'armada:relay-info:';

function readCachedInfo(relayUrl: string | undefined): RelayInfoDocument | undefined {
  if (!relayUrl) return undefined;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + relayUrl);
    return raw ? (JSON.parse(raw) as RelayInfoDocument) : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedInfo(relayUrl: string, info: RelayInfoDocument): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + relayUrl, JSON.stringify(info));
  } catch {
    // localStorage full / unavailable — non-fatal, we just lose the seed.
  }
}

/**
 * Fetch a relay's NIP-11 document directly (no react-query). Exported so
 * useRelayGroups can resolve the relay's signing key WITHOUT gating its
 * channel-list query on this hook's query lifecycle. Persists the last
 * known-good doc to the same localStorage seed the hook reads.
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

  return useQuery<RelayInfoDocument>({
    queryKey: ['relay-info', relayUrl],
    queryFn: ({ signal }) => fetchRelayInfoDoc(relayUrl!, signal),
    enabled: !!httpUrl,
    // Seed from the persisted last-known-good doc so name/avatar render
    // instantly and survive a reload on a flaky connection. `initialData` puts
    // it straight into the cache (treated as a real success), so a subsequent
    // fetch failure never blanks back to undefined. `initialDataUpdatedAt: 0`
    // marks the seed as already-stale so we still background-refresh once on
    // mount (picking up the rare real change) while showing last-known-good.
    initialData: () => readCachedInfo(relayUrl),
    initialDataUpdatedAt: 0,
    staleTime: 12 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}


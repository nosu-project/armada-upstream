import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { isNostrId } from "@/lib/nostrId";
import { normalizeRelayUrl } from "@/lib/platform";
import { isLocalNetworkUrl } from "@/lib/sanitizeUrl";
import { VerifiedRelay } from "@/lib/verifiedRelay";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Since the WHATWG change, `new WebSocket("/")` resolves against the page URL, so an
 * empty/relative hint would open a socket to our own origin.
 */
function sanitizeRelayHints(relays: string[] | undefined): string[] {
  return (relays ?? [])
    .map(normalizeRelayUrl)
    .filter((url): url is string => !!url);
}

/**
 * Sender-named relay hints narrowed to `wss:` on a public host: a loopback/LAN hint is a
 * blind probe of the viewer's network. User-configured relays use `sanitizeRelayHints`.
 */
export function publicRelayHints(relays: string[] | undefined): string[] {
  return sanitizeRelayHints(relays).filter(
    (url) => url.startsWith("wss://") && !isLocalNetworkUrl(url),
  );
}

/** NIP-65 write relays: unmarked tags are read+write; "write" tags are write-only. */
function extractWriteRelays(event: NostrEvent): string[] {
  const relays = new Set<string>();
  for (const [name, url, marker] of event.tags) {
    if (name !== "r" || marker === "read" || !url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "wss:") {
        relays.add(parsed.href);
      }
    } catch {
      // skip malformed URLs
    }
  }
  return [...relays];
}

type Pool = ReturnType<typeof useNostr>["nostr"];

const MAX_FALLBACK_RELAYS = 5;

/**
 * Query a relay the pool isn't connected to, never answering AUTH (which would reveal who
 * is looking). A relay requiring AUTH to read is a miss.
 */
async function queryUnauthenticated(
  url: string,
  filter: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  const relay = new VerifiedRelay(url);
  try {
    const events = await relay.query(filter, { signal });
    return events[0] ?? null;
  } catch {
    return null;
  } finally {
    void relay.close().catch(() => undefined);
  }
}

/**
 * Pool-connected relays go through the pool; the rest via {@link queryUnauthenticated},
 * so a lookup never adds an AUTH-answering relay to the pool.
 */
async function queryRelayGroup(
  nostr: Pool,
  urls: string[],
  filter: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  const relays = [...new Set(sanitizeRelayHints(urls))].slice(0, MAX_FALLBACK_RELAYS);
  if (relays.length === 0) return null;
  const pooled = relays.filter((url) => nostr.relays.has(url));
  const attempts = relays
    .filter((url) => !nostr.relays.has(url))
    .map((url) => queryUnauthenticated(url, filter, signal));
  if (pooled.length > 0) {
    attempts.push(
      nostr.group(pooled).query(filter, { signal }).then((events) => events[0] ?? null, () => null),
    );
  }
  return firstMatch(attempts);
}

/**
 * A miss isn't a rejection (unlike `Promise.any`), and a slow attempt can't hold back a
 * hit (unlike `Promise.all`).
 */
function firstMatch(attempts: Promise<NostrEvent | null>[]): Promise<NostrEvent | null> {
  if (attempts.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let remaining = attempts.length;
    const miss = () => {
      if (--remaining === 0) resolve(null);
    };
    for (const attempt of attempts) {
      attempt.then((event) => (event ? resolve(event) : miss()), miss);
    }
  });
}

async function queryAuthorRelays(
  nostr: Pool,
  pubkey: string,
  filter: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  try {
    const [relayList] = await nostr.query(
      [{ kinds: [10002], authors: [pubkey], limit: 1 }],
      { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
    );
    const writeRelays = relayList ? extractWriteRelays(relayList).slice(0, MAX_FALLBACK_RELAYS) : [];
    if (writeRelays.length === 0) return null;
    return await queryRelayGroup(nostr, writeRelays, filter, AbortSignal.any([signal, AbortSignal.timeout(6000)]));
  } catch {
    return null;
  }
}

/**
 * Last resort: events on the pool REFERENCING the id carry relay hints and author pubkeys;
 * chase those. No hardcoded relays.
 */
async function discoverViaReferences(
  nostr: Pool,
  eventId: string,
  filter: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  try {
    const refs = await nostr.query(
      [{ "#e": [eventId], limit: 20 }, { "#q": [eventId], limit: 20 }],
      { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
    );
    if (refs.length === 0) return null;

    const relayHints = new Set<string>();
    const pubkeys: string[] = [];
    const addPubkey = (pk: string | undefined) => {
      if (pk && isNostrId(pk) && !pubkeys.includes(pk)) pubkeys.push(pk);
    };
    // Strongest first: the relay + author on the tag naming our target.
    for (const ref of refs) {
      for (const [name, value, relay, author] of ref.tags) {
        if ((name === "e" || name === "q") && value === eventId) {
          if (relay) relayHints.add(relay);
          addPubkey(author);
        }
      }
    }
    for (const ref of refs) {
      for (const [name, value] of ref.tags) {
        if (name === "p") addPubkey(value);
      }
      addPubkey(ref.pubkey);
    }

    const attempts: Promise<NostrEvent | null>[] = [];
    if (relayHints.size > 0) {
      attempts.push(queryRelayGroup(nostr, publicRelayHints([...relayHints]), filter, AbortSignal.any([signal, AbortSignal.timeout(6000)])));
    }
    for (const pk of pubkeys.slice(0, 3)) {
      attempts.push(queryAuthorRelays(nostr, pk, filter, AbortSignal.any([signal, AbortSignal.timeout(8000)])));
    }
    return await firstMatch(attempts);
  } catch {
    return null;
  }
}

/**
 * Fetch one event by hex id: local cache, the pool, then concurrently identifier hints and
 * the author's NIP-65 write relays; with `opts.discover`, referencing events (opt-in: it asks the
 * public pool about the id — not for NIP-29 group messages). A miss returns null (cached like a hit).
 */
export function useEvent(
  eventId: string | undefined,
  relays?: string[],
  authorHint?: string,
  opts?: { fallbackAuthor?: string; discover?: boolean },
) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const outboxAuthor = authorHint || opts?.fallbackAuthor;
  const discover = !!opts?.discover;

  return useQuery<NostrRumor | null>({
    queryKey: ["event", eventId ?? "", relays ?? [], outboxAuthor ?? "", discover],
    queryFn: async () => {
      if (!eventId) return null;
      const filter: NostrFilter[] = [{ ids: [eventId], limit: 1 }];

      const store = await eventStore;
      // NIP-29 events live in their relay's own tenant, so a quoted group message misses here
      // and resolves from the relay below.
      const [cached] = await store.query(filter);
      if (cached) return cached;

      // A hung pool must not abort the fallbacks below.
      try {
        const events = await nostr.query(filter, { signal: AbortSignal.timeout(5000) });
        if (events.length > 0) return events[0];
      } catch {
        // fall through
      }

      const attempts: Promise<NostrEvent | null>[] = [];
      if (relays && relays.length > 0) {
        attempts.push(queryRelayGroup(nostr, relays, filter, AbortSignal.timeout(6000)));
      }
      if (outboxAuthor) {
        attempts.push(queryAuthorRelays(nostr, outboxAuthor, filter, AbortSignal.timeout(8000)));
      }
      const found = await firstMatch(attempts)
        ?? (discover ? await discoverViaReferences(nostr, eventId, filter, AbortSignal.timeout(15000)) : null);
      if (found) {
        // A `group()` read can't attribute group-scoped results, so the store drops those
        // (see db/relayScope.ts); global kinds still cache.
        void store.event(found);
        return found;
      }

      return null;
    },
    enabled: !!eventId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface AddrCoords {
  kind: number;
  pubkey: string;
  identifier: string;
}

function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

export function useAddrEvent(addr: AddrCoords | undefined, relays?: string[]) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  return useQuery<NostrRumor | null>({
    queryKey: ["addr-event", addr?.kind ?? 0, addr?.pubkey ?? "", addr?.identifier ?? ""],
    queryFn: async () => {
      if (!addr) return null;
      const baseFilter: NostrFilter = { kinds: [addr.kind], authors: [addr.pubkey], limit: 1 };
      if (isAddressableKind(addr.kind)) {
        baseFilter["#d"] = [addr.identifier];
      }
      const filter: NostrFilter[] = [baseFilter];

      try {
        const events = await nostr.query(filter, { signal: AbortSignal.timeout(5000) });
        if (events.length > 0) return events[0];
      } catch {
        // fall through
      }

      // An naddr always names its author, so their outbox is always a candidate.
      const attempts = [queryAuthorRelays(nostr, addr.pubkey, filter, AbortSignal.timeout(8000))];
      if (relays && relays.length > 0) {
        attempts.push(queryRelayGroup(nostr, relays, filter, AbortSignal.timeout(6000)));
      }
      const store = await eventStore;
      const found = await firstMatch(attempts);
      if (found) {
        void store.event(found);
        return found;
      }

      // A replaceable miss is usually a relay hiccup, not a deletion.
      const cacheFilter: NostrFilter = { kinds: [addr.kind], authors: [addr.pubkey] };
      if (isAddressableKind(addr.kind)) {
        cacheFilter["#d"] = [addr.identifier];
      }
      const [cached] = await store.query([cacheFilter]);
      return cached ?? null;
    },
    enabled: !!addr,
    staleTime: 5 * 60 * 1000,
  });
}

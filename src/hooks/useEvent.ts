import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { isNostrId } from "@/lib/nostrId";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Sanitize relay hints from untrusted content (nevent TLVs, q tags). Since the
 * WHATWG change, `new WebSocket("/")` resolves against the page URL instead of
 * throwing, so an empty/relative hint would otherwise open a socket to the
 * app's own origin.
 */
function sanitizeRelayHints(relays: string[] | undefined): string[] {
  return (relays ?? [])
    .map(normalizeRelayUrl)
    .filter((url): url is string => !!url);
}

/**
 * Extract write relay URLs from a NIP-65 (kind 10002) relay list event.
 * Tags with no marker are both read+write; tags with "write" are write-only.
 */
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

/** Most relays one fallback step will connect to. */
const MAX_FALLBACK_RELAYS = 5;

/** Query a group of relays; the first match, or null on a miss or failure. */
async function queryRelayGroup(
  nostr: Pool,
  urls: string[],
  filter: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrEvent | null> {
  const relays = [...new Set(sanitizeRelayHints(urls))].slice(0, MAX_FALLBACK_RELAYS);
  if (relays.length === 0) return null;
  try {
    const events = await nostr.group(relays).query(filter, { signal });
    return events[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The first non-null result among concurrent lookups, or null once all have
 * missed. A miss isn't a rejection (unlike `Promise.any`), and one slow
 * attempt can't hold back another's hit (unlike `Promise.all`).
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

/** Query an author's NIP-65 write relays (read from the pool) for the filter. */
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
 * Last resort for an id nothing pointed us at: events on the pool that
 * REFERENCE it (replies, quotes, reactions, zaps) carry relay hints and the
 * target author's pubkey in their `e`/`q` tags, and `p`-tag it or were written
 * by someone whose outbox likely holds it. Chase those — every relay here is
 * derived from the network, none is hardcoded.
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
    // Weaker: `p` tags, then the referencing authors themselves.
    for (const ref of refs) {
      for (const [name, value] of ref.tags) {
        if (name === "p") addPubkey(value);
      }
      addPubkey(ref.pubkey);
    }

    const attempts: Promise<NostrEvent | null>[] = [];
    if (relayHints.size > 0) {
      attempts.push(queryRelayGroup(nostr, [...relayHints], filter, AbortSignal.any([signal, AbortSignal.timeout(6000)])));
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
 * Fetches a single Nostr event by its hex ID. Resolution order (the same depth
 * as Ditto's lookup):
 * 1. Local cache (events are immutable, so a hit is authoritative)
 * 2. The configured relay pool
 * 3. Concurrently: relay hints from the identifier, and the author's NIP-65
 *    write relays (`authorHint`, else `opts.fallbackAuthor` — e.g. the author
 *    of the message quoting it)
 * 4. With `opts.discover`: events on the pool that reference the id, and the
 *    hints they carry. Opt-in because it asks the public pool about the id —
 *    fine for a quoted public note, not for a NIP-29 group message.
 *
 * A miss returns null rather than throwing, so it is cached like a hit; a
 * caller offering "retry" refetches.
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
      // The global cache. A NIP-29 event lives in its relay's own tenant instead,
      // and an id alone doesn't say which relay that is — so a quoted group
      // message misses here and is resolved from the relay below, which is the
      // only place it authoritatively exists anyway.
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
        // A `group()` read has N candidate relays for one event, so it can't
        // attribute a group-scoped result; the store drops those rather than
        // file them under a guess (see db/relayScope.ts). Global kinds — the
        // usual case for a quoted event — still cache.
        void store.event(found);
        return found;
      }

      return null;
    },
    enabled: !!eventId,
    staleTime: 5 * 60 * 1000,
  });
}

/** Coordinates for an addressable event (naddr). */
export interface AddrCoords {
  kind: number;
  pubkey: string;
  identifier: string;
}

/** Whether a kind is addressable (30000-39999) and thus identified by its d-tag. */
function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** Fetches a single addressable Nostr event by kind + pubkey + d-tag. */
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

      // An naddr always names its author, so their outbox is always a
      // candidate beside whatever hints it carried. Concurrent; first hit wins.
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

      // Fall back to the locally cached copy (a replaceable miss is usually a
      // relay hiccup, not a deletion).
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

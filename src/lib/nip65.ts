import { verifyEvent } from "nostr-tools";

import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** NIP-65 relay-list metadata event kind. */
export const KIND_RELAY_LIST = 10002;

/**
 * A signed relay list controls live sockets, fan-out and background work. Keep
 * a malformed or unexpectedly huge list from turning one login into an
 * unbounded connection storm. NIP-65 recommends only 2-4 relays per category;
 * sixteen still leaves ample room for overlap and migrations.
 */
export const MAX_RELAY_LIST_RELAYS = 16;

export interface RelayPreference {
  url: string;
  read: boolean;
  write: boolean;
}

interface RelayQueryClient {
  relay(url: string): {
    query(
      filters: NostrFilter[],
      opts: { signal: AbortSignal },
    ): Promise<NostrEvent[]>;
  };
}

interface RelayPublishClient {
  relay(url: string): {
    event(event: NostrEvent, opts: { signal: AbortSignal }): Promise<unknown>;
  };
}

export interface RelayListPublishResult {
  accepted: string[];
  rejected: string[];
}

export interface RelayListDiscovery {
  event: NostrEvent;
  relays: RelayPreference[];
}

/**
 * Parse and normalize a kind-10002 event. Bare `r` tags are read+write;
 * duplicate read/write tags for one URL are merged instead of first-wins.
 */
export function parseRelayList(event: Pick<NostrEvent, "tags">): RelayPreference[] {
  const byUrl = new Map<string, RelayPreference>();

  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]) continue;
    const url = normalizeRelayUrl(tag[1]);
    if (!url) continue;

    const marker = tag[2];
    if (marker && marker !== "read" && marker !== "write") continue;

    let relay = byUrl.get(url);
    if (!relay) {
      if (byUrl.size >= MAX_RELAY_LIST_RELAYS) continue;
      relay = { url, read: false, write: false };
      byUrl.set(url, relay);
    }

    if (!marker) {
      relay.read = true;
      relay.write = true;
    } else if (marker === "read") {
      relay.read = true;
    } else {
      relay.write = true;
    }
  }

  return [...byUrl.values()].filter((relay) => relay.read || relay.write);
}

/** Build canonical NIP-65 `r` tags from relay preferences. */
export function buildRelayListTags(relays: RelayPreference[]): string[][] {
  const normalized = parseRelayList({
    tags: relays.flatMap((relay) => {
      if (relay.read && relay.write) return [["r", relay.url]];
      if (relay.read) return [["r", relay.url, "read"]];
      if (relay.write) return [["r", relay.url, "write"]];
      return [];
    }),
  });

  return normalized.map((relay) => {
    if (relay.read && relay.write) return ["r", relay.url];
    return ["r", relay.url, relay.read ? "read" : "write"];
  });
}

/** Newest replaceable event: highest timestamp, then lowest id on a tie. */
export function newestRelayList(events: NostrEvent[]): NostrEvent | undefined {
  return events
    .filter((event) => event.kind === KIND_RELAY_LIST && verifyEvent(event))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/** Normalize and dedupe relay URLs while preserving their first-seen order. */
export function uniqueRelayUrls(relays: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of relays) {
    const url = normalizeRelayUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Query explicit relays independently and combine their valid events. One
 * offline indexer cannot suppress a result already returned by another.
 */
export async function queryExplicitRelays(
  nostr: RelayQueryClient,
  relayUrls: Iterable<string>,
  filters: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const urls = uniqueRelayUrls(relayUrls);
  const settled = await Promise.allSettled(
    urls.map((url) => nostr.relay(url).query(filters, { signal })),
  );
  const byId = new Map<string, NostrEvent>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const event of result.value) {
      if (verifyEvent(event)) byId.set(event.id, event);
    }
  }
  return [...byId.values()];
}

/** Find a user's newest signed NIP-65 list on a bounded discovery set. */
export async function discoverRelayList(
  nostr: RelayQueryClient,
  pubkey: string,
  relayUrls: Iterable<string>,
  signal: AbortSignal,
): Promise<RelayListDiscovery | undefined> {
  const events = await queryExplicitRelays(
    nostr,
    relayUrls,
    [{ kinds: [KIND_RELAY_LIST], authors: [pubkey], limit: 1 }],
    signal,
  );
  const event = newestRelayList(events.filter((candidate) => candidate.pubkey === pubkey));
  if (!event) return undefined;
  const relays = parseRelayList(event);
  if (relays.length === 0) return undefined;
  return { event, relays };
}

/** Fan one already-signed relay-list event to every explicit destination. */
export async function publishRelayListEvent(
  nostr: RelayPublishClient,
  event: NostrEvent,
  relayUrls: Iterable<string>,
  timeoutMs: number,
): Promise<RelayListPublishResult> {
  const targets = uniqueRelayUrls(relayUrls);
  const settled = await Promise.allSettled(
    targets.map((url) =>
      nostr.relay(url).event(event, { signal: AbortSignal.timeout(timeoutMs) }),
    ),
  );
  return {
    accepted: targets.filter((_, index) => settled[index]?.status === "fulfilled"),
    rejected: targets.filter((_, index) => settled[index]?.status === "rejected"),
  };
}

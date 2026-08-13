import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { accountDataRelays, effectiveDmRelays, selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { normalizeRelayUrl } from "@/lib/platform";
import {
  KIND_RELAY_LIST,
  newestRelayList,
  parseRelayList,
  queryExplicitRelays,
  uniqueRelayUrls,
} from "@/lib/nip65";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * NIP-17 DM relay list kind. A user publishes the relays where they want to
 * receive direct messages here; other clients read it to know where to send.
 * The list is a plain (unencrypted) replaceable event whose `relay` tags hold
 * the URLs.
 */
export const KIND_DM_RELAYS = 10050;

/** Extract the relay URLs from a kind-10050 event's `relay` tags. */
export function parseDmRelays(event: { tags: string[][] } | undefined): string[] {
  if (!event) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const [name, url] of event.tags) {
    if (name !== "relay" || !url) continue;
    const n = normalizeRelayUrl(url);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    urls.push(n);
  }
  return urls;
}

export interface DmRelayListQuery {
  event: NostrEvent | null;
  relays: string[];
}

type DmRelayQueryClient = Parameters<typeof queryExplicitRelays>[0];

/**
 * Per-round discovery budget. The two rounds below are necessarily sequential
 * (the second needs the first's NIP-65 answer), so a single shared deadline
 * lets a slow or AUTH-gated app relay starve the round that exists precisely to
 * look BEYOND the app relays.
 */
const DISCOVERY_ROUND_MS = 6000;

/** Newest kind-10050 event for one peer, using NIP-01 replaceable ordering. */
function newestDmRelayList(events: NostrEvent[], peer: string): NostrEvent | undefined {
  return events
    .filter((event) => event.kind === KIND_DM_RELAYS && event.pubkey === peer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/**
 * Discover a peer's NIP-17 inbox without assuming their kind-10050 event lives
 * on Armada's app relays. First query every configured account/DM discovery
 * relay independently (important for slow or NIP-42-authenticated relays), then
 * — only when `followPeerRelays` — follow the peer's NIP-65 WRITE relays and
 * choose the newest replaceable event across both rounds. A newer empty list
 * remains authoritative.
 *
 * `followPeerRelays` has no default because it is a disclosure decision, not a
 * tuning knob: the second round DIALS relays the PEER named, and every pool
 * connection answers NIP-42 by signing a kind-22242 with the viewer's key (see
 * `NostrProvider`), so it hands infrastructure of the peer's choosing the
 * viewer's IP bound to their pubkey. Callers must say who they are talking to.
 */
export async function discoverDmRelaysFor(
  nostr: DmRelayQueryClient,
  peer: string,
  discoveryRelays: Iterable<string>,
  signal: AbortSignal,
  { followPeerRelays }: { followPeerRelays: boolean },
): Promise<string[]> {
  const round = () => AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_ROUND_MS)]);

  const discoveryEvents = await queryExplicitRelays(
    nostr,
    discoveryRelays,
    [
      { kinds: [KIND_DM_RELAYS], authors: [peer], limit: 1 },
      { kinds: [KIND_RELAY_LIST], authors: [peer], limit: 1 },
    ],
    round(),
  );

  const relayList = followPeerRelays
    ? newestRelayList(discoveryEvents.filter((event) => event.pubkey === peer))
    : undefined;
  const peerWriteRelays = relayList
    ? parseRelayList(relayList).filter((relay) => relay.write).map((relay) => relay.url)
    : [];
  const peerEvents = peerWriteRelays.length > 0
    ? await queryExplicitRelays(
        nostr,
        peerWriteRelays,
        [{ kinds: [KIND_DM_RELAYS], authors: [peer], limit: 1 }],
        round(),
      )
    : [];

  return parseDmRelays(newestDmRelayList([...discoveryEvents, ...peerEvents], peer));
}

/**
 * Read and write the user's NIP-17 DM relay list (kind 10050).
 *
 * Used by Settings: when the user opts into "use my own DM relays" we seed the
 * editor from their existing published list (if any) rather than from the app
 * relays, and edits write the list back so it stays the canonical, discoverable
 * source of where their DMs live.
 */
export function useDmRelayList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  const queryKey = ["dm-relay-list", user?.pubkey];

  const query = useQuery<DmRelayListQuery>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const events = await queryExplicitRelays(
        nostr,
        selfStateRelays(config, user!.pubkey),
        [{ kinds: [KIND_DM_RELAYS], authors: [user!.pubkey], limit: 1 }],
        AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      );
      const event = events.sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )[0] ?? null;
      return { event, relays: parseDmRelays(event ?? undefined) };
    },
    staleTime: 60_000,
  });

  const publish = useMutation({
    mutationFn: async (relays: string[]) => {
      if (!user) throw new Error("Not logged in");
      const urls = relays
        .map((r) => normalizeRelayUrl(r))
        .filter((r): r is string => !!r);
      const events = await queryExplicitRelays(
        nostr,
        selfStateRelays(config, user.pubkey),
        [{ kinds: [KIND_DM_RELAYS], authors: [user.pubkey], limit: 1 }],
        AbortSignal.timeout(8_000),
      );
      const prev = events.sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )[0] ?? null;
      const cached = queryClient.getQueryData<DmRelayListQuery>(queryKey);
      if (!prev && cached?.event) {
        throw new Error("Could not refresh your existing DM relay list; no changes were published");
      }
      const tags = [
        ...(prev?.tags.filter(([name]) => name !== "relay" && name !== "client") ?? []),
        ...urls.map((url) => ["relay", url]),
      ];
      const createdAt = prev
        ? Math.max(Math.floor(Date.now() / 1000), prev.created_at + 1)
        : Math.floor(Date.now() / 1000);

      await publishEvent({
        kind: KIND_DM_RELAYS,
        content: prev?.content ?? "",
        tags,
        created_at: createdAt,
        prev: prev ?? undefined,
        relays: selfStateRelays(config, user.pubkey),
        onSigned: (event) => {
          queryClient.setQueryData<DmRelayListQuery>(queryKey, { event, relays: urls });
        },
      });
      return urls;
    },
  });

  return {
    /** The user's published DM relays (empty if they have none). */
    relays: query.data?.relays ?? [],
    event: query.data?.event ?? null,
    isLoading: query.isLoading,
    /** Whether a 10050 list with at least one relay exists. */
    hasList: (query.data?.relays.length ?? 0) > 0,
    refetch: query.refetch,
    /** Publish a new kind-10050 DM relay list. */
    publish: publish.mutateAsync,
  };
}

/**
 * Read another user's published kind-10050 DM relay list (NIP-17), so we can
 * deliver DMs to the relays where they actually read. Discovery always covers
 * the configured account/DM relays, and follows the peer's NIP-65 write relays
 * only for KNOWN peers (see below). Returns `[]` when no signed list is found;
 * callers fall back to their own DM relays for compatibility with clients that
 * never published kind 10050.
 *
 * This closes the cross-relay delivery gap: writing only to the *sender's*
 * relays silently fails when the peer doesn't read them. By unioning the peer's
 * published inbox relays into the write set, a message lands somewhere the
 * recipient is actually listening.
 */
export function useDmRelaysFor(peer: string | undefined): string[] {
  const peers = useMemo(() => (peer ? [peer] : []), [peer]);
  const byPeer = useDmRelaysForAll(peers);
  return byPeer.get(peer ?? "") ?? EMPTY_RELAYS;
}

/** Shared empty result, so a peerless render keeps a stable array identity. */
const EMPTY_RELAYS: string[] = [];

/**
 * The multi-participant form of {@link useDmRelaysFor}: every recipient's
 * published NIP-17 inbox, keyed by pubkey.
 *
 * A group DM is delivered as one gift wrap PER participant, each to that
 * participant's own inbox, so the send path needs all of them resolved before
 * it can route anything. They are resolved concurrently rather than through N
 * hook instances (a hook per peer would be a conditional hook the moment the
 * participant set changes) and cached under one key.
 *
 * The `followPeerRelays` disclosure decision stays PER PEER — see
 * {@link discoverDmRelaysFor}. Reaching past our own relays hands the peer's
 * infrastructure our IP and pubkey, and being in a group with someone we
 * haven't accepted must not spend that on their behalf.
 */
export function useDmRelaysForAll(peers: readonly string[]): Map<string, string[]> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const { isKnown } = useKnownDmPeers();
  const discoveryRelays = useMemo(
    () => uniqueRelayUrls([
      ...accountDataRelays(config, user?.pubkey),
      ...effectiveDmRelays(config),
    ]),
    [config, user?.pubkey],
  );
  const relayKey = discoveryRelays.join(",");

  // Sorted so two orderings of the same set share one cache entry, and joined
  // with the known-flags so a peer promoted out of the request tier re-runs
  // discovery rather than keeping its gated `[]`.
  const targets = useMemo(
    () => [...new Set(peers)].filter(Boolean).sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [peers.join(",")],
  );
  const knownKey = targets.map((peer) => (isKnown(peer, false) ? "1" : "0")).join("");

  const query = useQuery<Record<string, string[]>>({
    queryKey: ["dm-relay-list", "peers", targets.join(","), relayKey, knownKey],
    enabled: targets.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const settled = await Promise.all(
        targets.map(async (peer) => {
          const relays = await discoverDmRelaysFor(nostr, peer, discoveryRelays, signal, {
            followPeerRelays: isKnown(peer, false),
          }).catch(() => [] as string[]);
          return [peer, relays] as const;
        }),
      );
      return Object.fromEntries(settled);
    },
  });

  return useMemo(() => new Map(Object.entries(query.data ?? {})), [query.data]);
}

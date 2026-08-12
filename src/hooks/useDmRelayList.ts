import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { accountDataRelays, effectiveDmRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
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
 * follow the peer's NIP-65 WRITE relays and choose the newest replaceable event
 * across both rounds. A newer empty list remains authoritative.
 */
export async function discoverDmRelaysFor(
  nostr: DmRelayQueryClient,
  peer: string,
  discoveryRelays: Iterable<string>,
  signal: AbortSignal,
): Promise<string[]> {
  const discoveryEvents = await queryExplicitRelays(
    nostr,
    discoveryRelays,
    [
      { kinds: [KIND_DM_RELAYS], authors: [peer], limit: 1 },
      { kinds: [KIND_RELAY_LIST], authors: [peer], limit: 1 },
    ],
    signal,
  );

  const relayList = newestRelayList(
    discoveryEvents.filter((event) => event.pubkey === peer),
  );
  const peerWriteRelays = relayList
    ? parseRelayList(relayList).filter((relay) => relay.write).map((relay) => relay.url)
    : [];
  const peerEvents = peerWriteRelays.length > 0
    ? await queryExplicitRelays(
        nostr,
        peerWriteRelays,
        [{ kinds: [KIND_DM_RELAYS], authors: [peer], limit: 1 }],
        signal,
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
        accountDataRelays(config, user!.pubkey),
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
        accountDataRelays(config, user.pubkey),
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
 * deliver DMs to the relays where they actually read. Discovery covers the
 * configured account/DM relays and follows the peer's NIP-65 write relays.
 * Returns `[]` when no signed list is found; callers fall back to their own DM
 * relays for compatibility with clients that never published kind 10050.
 *
 * This closes the cross-relay delivery gap: writing only to the *sender's*
 * relays silently fails when the peer doesn't read them. By unioning the peer's
 * published inbox relays into the write set, a message lands somewhere the
 * recipient is actually listening.
 */
export function useDmRelaysFor(peer: string | undefined): string[] {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const discoveryRelays = uniqueRelayUrls([
    ...accountDataRelays(config, user?.pubkey),
    ...effectiveDmRelays(config),
  ]);
  const relayKey = discoveryRelays.join(",");

  const query = useQuery<string[]>({
    queryKey: ["dm-relay-list", "peer", peer, relayKey],
    enabled: !!peer,
    // Missing lists are common with older clients. Recheck often enough that a
    // newly published inbox is adopted without leaving a false result cached
    // for an hour, while still keeping this off the hot path.
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      return discoverDmRelaysFor(
        nostr,
        peer!,
        discoveryRelays,
        AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      );
    },
  });

  return query.data ?? [];
}

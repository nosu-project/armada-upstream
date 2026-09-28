import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { parseAddr } from "@/lib/parseAddr";
import { sanitizeUrl } from "@/lib/sanitizeUrl";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { useEventStore as useEventStoreType } from "@/hooks/useEventStore";

type EventStore = ReturnType<typeof useEventStoreType>;
type Nostr = ReturnType<typeof useNostr>["nostr"];

/** NIP-58 kinds: award (8), profile badges list (30008), badge definition (30009). */
const KIND_BADGE_AWARD = 8;
const KIND_PROFILE_BADGES = 30008;
const KIND_BADGE_DEFINITION = 30009;

export interface ProfileBadge {
  addr: string;
  issuer: string;
  identifier: string;
  name: string;
  description?: string;
  image?: string;
  /** Falls back to `image` at render time. */
  thumb?: string;
}

/**
 * Badges a person WEARS (NIP-58): consecutive `a`/`e` pairs in their kind 30008, each verified
 * against a kind-8 award signed by the definition's issuer and naming this person. Anything less
 * lets anyone wear any badge.
 */
export function profileBadgesQueryKey(pubkey: string): [string, string] {
  return ["profile-badges", pubkey];
}

/** Shared with the `usePrefetchProfile` prefetch so both fill one cache entry. */
export function profileBadgesQueryOptions(
  nostr: Nostr,
  eventStore: EventStore,
  pubkey: string | undefined,
) {
  return {
    queryKey: profileBadgesQueryKey(pubkey ?? ""),
    enabled: !!pubkey,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ProfileBadge[]> => {
      if (!pubkey) return [];
      const store = await eventStore;

      // STORE-FIRST: resolution is two dependent rounds, and a stored list lets round two start
      // immediately; the network refresh serves the next open.
      const [cached] = await store.query([
        { kinds: [KIND_PROFILE_BADGES], authors: [pubkey], "#d": ["profile_badges"] },
      ]);
      let list: NostrRumor | undefined = cached;
      if (cached) {
        void Promise.resolve(
          nostr.query(
            [{ kinds: [KIND_PROFILE_BADGES], authors: [pubkey], "#d": ["profile_badges"], limit: 1 }],
            { signal },
          ),
        )
          .then(([fresh]) => {
            if (fresh && fresh.created_at > cached.created_at) void store.event(fresh);
          })
          .catch(() => undefined);
      } else {
        const [fromNet] = await nostr.query(
          [{ kinds: [KIND_PROFILE_BADGES], authors: [pubkey], "#d": ["profile_badges"], limit: 1 }],
          { signal },
        );
        list = fromNet;
        if (fromNet) void store.event(fromNet);
      }
      if (!list) return [];

      // An `a` without a following `e` is unverifiable and skipped.
      const pairs: { addr: string; awardId: string }[] = [];
      let pendingAddr: string | undefined;
      for (const tag of list.tags) {
        if (tag[0] === "a") {
          pendingAddr = tag[1];
        } else if (tag[0] === "e" && pendingAddr && tag[1]) {
          pairs.push({ addr: pendingAddr, awardId: tag[1] });
          pendingAddr = undefined;
        }
      }
      if (pairs.length === 0) return [];

      const parsed = pairs
        .map((p) => ({ ...p, coord: parseAddr(p.addr) }))
        .filter((p) => p.coord?.kind === KIND_BADGE_DEFINITION);
      if (parsed.length === 0) return [];

      // The definition filter is authors × d-tags and can over-select; matched exactly below.
      const [definitions, awards] = await Promise.all([
        nostr.query(
          [{
            kinds: [KIND_BADGE_DEFINITION],
            authors: [...new Set(parsed.map((p) => p.coord!.pubkey))],
            "#d": [...new Set(parsed.map((p) => p.coord!.identifier))],
          }],
          { signal },
        ),
        nostr.query(
          [{ kinds: [KIND_BADGE_AWARD], ids: parsed.map((p) => p.awardId) }],
          { signal },
        ),
      ]);

      const defByCoord = new Map<string, (typeof definitions)[number]>();
      for (const def of definitions) {
        const d = def.tags.find(([n]) => n === "d")?.[1] ?? "";
        const key = `${KIND_BADGE_DEFINITION}:${def.pubkey}:${d}`;
        const existing = defByCoord.get(key);
        if (!existing || existing.created_at < def.created_at) defByCoord.set(key, def);
      }
      const awardById = new Map(awards.map((a) => [a.id, a]));

      const out: ProfileBadge[] = [];
      for (const p of parsed) {
        const def = defByCoord.get(p.addr);
        if (!def) continue;
        const award = awardById.get(p.awardId);
        if (!award) continue;
        // The award must come from the badge's issuer and name this person.
        if (award.pubkey !== p.coord!.pubkey) continue;
        if (!award.tags.some((t) => t[0] === "p" && t[1] === pubkey)) continue;

        const name = def.tags.find(([n]) => n === "name")?.[1];
        if (!name) continue;
        out.push({
          addr: p.addr,
          issuer: p.coord!.pubkey,
          identifier: p.coord!.identifier,
          name,
          description: def.tags.find(([n]) => n === "description")?.[1],
          image: sanitizeUrl(def.tags.find(([n]) => n === "image")?.[1]),
          thumb: sanitizeUrl(def.tags.find(([n]) => n === "thumb")?.[1]),
        });
      }
      return out;
    },
  };
}

export function useProfileBadges(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  return useQuery<ProfileBadge[]>(profileBadgesQueryOptions(nostr, eventStore, pubkey));
}

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { parseAddr } from "@/lib/parseAddr";
import { sanitizeUrl } from "@/lib/sanitizeUrl";

import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-58 kinds: award (8), profile badges list (30008), badge definition (30009). */
const KIND_BADGE_AWARD = 8;
const KIND_PROFILE_BADGES = 30008;
const KIND_BADGE_DEFINITION = 30009;

export interface ProfileBadge {
  /** The definition coordinate (`30009:<issuer>:<d>`). */
  addr: string;
  /** Issuer pubkey (from the coordinate). */
  issuer: string;
  name: string;
  description?: string;
  /** Full-size image URL. */
  image?: string;
  /** Thumbnail URL (falls back to `image` at render time). */
  thumb?: string;
}

/**
 * The badges a person WEARS: their kind-30008 `profile_badges` list, resolved
 * to definitions and verified against the awards (NIP-58). The list is
 * consecutive `a`/`e` pairs — the `a` names the definition, the `e` the
 * kind-8 award. A badge renders only when all three check out: the pair is in
 * the list, the award exists, is signed by the definition's issuer, and names
 * this person in a `p` tag. Anything less lets anyone wear any badge by
 * spelling its coordinate.
 */
export function useProfileBadges(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  return useQuery<ProfileBadge[]>({
    queryKey: ["profile-badges", pubkey ?? ""],
    enabled: !!pubkey,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (!pubkey) return [];
      const store = await eventStore;

      const [fromNet] = await nostr.query(
        [{ kinds: [KIND_PROFILE_BADGES], authors: [pubkey], "#d": ["profile_badges"], limit: 1 }],
        { signal },
      );
      let list: NostrRumor | undefined = fromNet;
      if (fromNet) {
        void store.event(fromNet);
      } else {
        [list] = await store.query([
          { kinds: [KIND_PROFILE_BADGES], authors: [pubkey], "#d": ["profile_badges"] },
        ]);
      }
      if (!list) return [];

      // Consecutive a/e pairs, in list order. An `a` without a following `e`
      // is an unverifiable claim and is skipped.
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

      // One round for the definitions, one for the awards. The definition
      // filter is a cartesian over authors × d-tags, so it can over-select;
      // rows are matched back to exact coordinates below.
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
          name,
          description: def.tags.find(([n]) => n === "description")?.[1],
          image: sanitizeUrl(def.tags.find(([n]) => n === "image")?.[1]),
          thumb: sanitizeUrl(def.tags.find(([n]) => n === "thumb")?.[1]),
        });
      }
      return out;
    },
  });
}

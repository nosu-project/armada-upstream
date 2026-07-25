import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useBuzzEmojiPalette } from "@/buzz/useBuzzEmojiPalette";
import { useChatScope } from "@/hooks/useChatScope";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { parseAddr } from "@/lib/parseAddr";

import type { NostrEvent } from "@nostrify/nostrify";

export interface CustomEmoji {
  shortcode: string;
  url: string;
}

/** Newest event per addressable coordinate (`kind:pubkey:d`), first-seen order. */
function newestPerAddr(events: NostrEvent[]): NostrEvent[] {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const identifier = event.tags.find(([name]) => name === "d")?.[1] ?? "";
    const addr = `${event.kind}:${event.pubkey}:${identifier}`;
    const prev = newest.get(addr);
    if (!prev || event.created_at > prev.created_at) newest.set(addr, event);
  }
  return [...newest.values()];
}

/**
 * Query the current user's NIP-30 custom emoji list (kind 10030).
 *
 * Extracts emojis from two sources:
 * 1. Inline `['emoji', shortcode, url]` tags directly in the kind 10030 event
 * 2. Referenced emoji packs via `['a', '30030:pubkey:identifier']` tags —
 *    these kind 30030 events are fetched and their emoji tags are merged in
 */
export function useCustomEmojis() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  const query = useQuery({
    queryKey: ["custom-emojis", user?.pubkey ?? ""],
    queryFn: async ({ signal }) => {
      if (!user) return [];

      const store = await eventStore;

      // Relay ∪ local store, newest wins — same shape as the pack reads below.
      // An empty relay result is almost always transient rather than a real
      // empty list (the batcher merges replaceable kinds into one REQ and
      // resolves at the first EOSE, so a slow relay holding the 10030 can be
      // raced out; a cold pool or AUTH does the same), and this query is
      // invalidated on every incoming 10030 by NostrSync, so returning []
      // here overwrites a good list with an empty one. Merging (rather than
      // falling back on a miss) also stops a stale relay copy from beating a
      // newer cached one.
      const [relayList, cachedList] = await Promise.all([
        nostr.query(
          [{ kinds: [10030], authors: [user.pubkey], limit: 1 }],
          { signal },
        ),
        store.query([{ kinds: [10030], authors: [user.pubkey] }])
          .catch(() => [] as NostrEvent[]),
      ]);

      const listEvent = [...relayList, ...cachedList]
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!listEvent) return [];

      // Collect all emojis with their source pack identifier so we can
      // detect shortcode collisions across packs and prefix them.
      interface RawEmoji {
        shortcode: string;
        url: string;
        packId: string;
      }
      const raw: RawEmoji[] = [];

      for (const tag of listEvent.tags) {
        if (tag[0] === "emoji" && tag[1] && tag[2]) {
          raw.push({ shortcode: tag[1], url: tag[2], packId: "" });
        }
      }

      // Resolve referenced emoji packs (kind 30030)
      const packRefs: { kind: number; pubkey: string; identifier: string }[] = [];
      for (const tag of listEvent.tags) {
        if (tag[0] === "a" && tag[1]) {
          const parsed = parseAddr(tag[1]);
          if (parsed && parsed.kind === 30030) {
            packRefs.push(parsed);
          }
        }
      }

      if (packRefs.length > 0) {
        const filters = packRefs.map((ref) => ({
          kinds: [30030 as number],
          authors: [ref.pubkey],
          "#d": [ref.identifier],
          limit: 1,
        }));

        // Relay ∪ local store, newest per pack. Most users' emojis live behind
        // these `a` refs rather than inline tags (adding a pack writes an `a`
        // tag), so a partial or failed pack read empties the list even when the
        // 10030 above resolved fine. The store floor makes a miss non-destructive.
        const [relayPacks, cachedPacks] = await Promise.all([
          nostr.query(filters, { signal }).catch(() => [] as NostrEvent[]),
          store.query(filters).catch(() => [] as NostrEvent[]),
        ]);

        for (const packEvent of newestPerAddr([...relayPacks, ...cachedPacks])) {
          const packId = packEvent.tags.find(([n]) => n === "d")?.[1] ?? "";
          for (const tag of packEvent.tags) {
            if (tag[0] === "emoji" && tag[1] && tag[2]) {
              raw.push({ shortcode: tag[1], url: tag[2], packId });
            }
          }
        }
      }

      // Detect collisions (same shortcode, different URLs) and prefix with pack id.
      const byShortcode = new Map<string, RawEmoji[]>();
      for (const entry of raw) {
        const group = byShortcode.get(entry.shortcode);
        if (group) {
          group.push(entry);
        } else {
          byShortcode.set(entry.shortcode, [entry]);
        }
      }

      const collisions = new Set<string>();
      for (const [shortcode, group] of byShortcode) {
        const uniqueUrls = new Set(group.map((e) => e.url));
        if (uniqueUrls.size > 1) {
          collisions.add(shortcode);
        }
      }

      const emojis: CustomEmoji[] = [];
      const seen = new Set<string>();

      for (const entry of raw) {
        const finalShortcode = collisions.has(entry.shortcode) && entry.packId
          ? `${entry.packId}-${entry.shortcode}`
          : entry.shortcode;

        if (!seen.has(finalShortcode)) {
          seen.add(finalShortcode);
          emojis.push({ shortcode: finalShortcode, url: entry.url });
        }
      }

      return emojis;
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  // Buzz workspaces share a community palette (the union of every member's
  // `buzz:custom-emoji` kind-30030 set). When the surrounding chat scope is a
  // channel on a Buzz relay, merge that palette in — the user's own emojis
  // win shortcode collisions.
  const scope = useChatScope();
  const scopeRelay = scope?.kind === "nip29" ? scope.relayUrl : undefined;
  const buzzPalette = useBuzzEmojiPalette(scopeRelay);

  const emojis = useMemo(() => {
    const own = query.data ?? [];
    if (buzzPalette.length === 0) return own;
    const seen = new Set(own.map((e) => e.shortcode));
    const merged = [...own];
    for (const e of buzzPalette) {
      if (!seen.has(e.shortcode)) {
        seen.add(e.shortcode);
        merged.push(e);
      }
    }
    return merged;
  }, [query.data, buzzPalette]);

  return {
    emojis,
    isLoading: query.isLoading,
  };
}

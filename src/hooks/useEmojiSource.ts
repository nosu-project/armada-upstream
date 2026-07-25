import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { emojiPackCoord, emojiPackName, KIND_EMOJI_SET } from "@/hooks/useEmojiPacks";
import { useEventStore } from "@/hooks/useEventStore";
import { parseAddr } from "@/lib/parseAddr";

import type { NostrEvent } from "@nostrify/nostrify";

/** The pack a custom emoji came from, enough to display it and add it. */
export interface EmojiSource {
  /** `30030:pubkey:dtag`. */
  coord: string;
  /** The pack's human name. */
  name: string;
  /** Pack author, for the add mutation. */
  pubkey: string;
  /** The pack's `d` identifier, for the add mutation. */
  identifier: string;
}

/** How many locally-cached packs to scan when resolving an emoji's origin. */
const STORE_PACK_LIMIT = 500;

/**
 * Index every kind-30030 pack in the local event store by emoji image URL.
 *
 * This is what lets us name the pack behind an emoji the user does NOT have:
 * packs shared in chat (rendered as an EmojiPackCard) and packs pulled in by
 * any other read are mirrored into the store, so a reaction using one of their
 * emojis can be traced back without a fresh relay round-trip. There is no
 * network query here on purpose — a reaction's `["emoji", code, url]` tag
 * carries no pack reference, and relays can't be filtered by emoji URL, so an
 * unknown emoji simply stays unattributed rather than triggering a fan-out.
 */
function usePackIndex() {
  const eventStore = useEventStore();

  return useQuery({
    queryKey: ["emoji-pack-url-index"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, EmojiSource>> => {
      const store = await eventStore;
      const events = await store
        .query([{ kinds: [KIND_EMOJI_SET], limit: STORE_PACK_LIMIT }])
        .catch(() => [] as NostrEvent[]);

      // Newest event per coordinate wins, so a renamed/edited pack resolves to
      // its current name rather than whichever revision the cursor hit first.
      const newest = new Map<string, NostrEvent>();
      for (const ev of events) {
        const identifier = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
        const coord = emojiPackCoord(ev.pubkey, identifier);
        const prev = newest.get(coord);
        if (!prev || ev.created_at > prev.created_at) newest.set(coord, ev);
      }

      const index = new Map<string, EmojiSource>();
      for (const [coord, ev] of newest) {
        const identifier = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
        const source: EmojiSource = {
          coord,
          name: emojiPackName(ev),
          pubkey: ev.pubkey,
          identifier,
        };
        for (const t of ev.tags) {
          // First pack to claim a URL keeps it: an emoji copied into a later
          // pack shouldn't reattribute the original.
          if (t[0] === "emoji" && t[2] && !index.has(t[2])) index.set(t[2], source);
        }
      }
      return index;
    },
  });
}

/**
 * Resolve which NIP-30 pack a custom emoji came from, for the "from <pack>"
 * line and its Add button.
 *
 * Checks the user's own resolved palette first (which already carries pack
 * provenance and covers the community palette), then falls back to the local
 * pack index. Returns undefined for native emoji and for custom emoji whose
 * pack we've simply never seen.
 */
export function useEmojiSource(url: string | undefined): EmojiSource | undefined {
  const { emojis } = useCustomEmojis();
  const { data: index } = usePackIndex();

  return useMemo(() => {
    if (!url) return undefined;

    const own = emojis.find((e) => e.url === url && e.packCoord);
    if (own?.packCoord) {
      const addr = parseAddr(own.packCoord);
      if (addr) {
        return {
          coord: own.packCoord,
          name: own.packName || addr.identifier || "Emoji pack",
          pubkey: addr.pubkey,
          identifier: addr.identifier,
        };
      }
    }

    return index?.get(url);
  }, [url, emojis, index]);
}

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useBuzzEmojiPalette } from "@/buzz/useBuzzEmojiPalette";
import { accountDataRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useChatScope } from "@/hooks/useChatScope";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { emojiPackCoord, emojiPackName, readEmojiList } from "@/hooks/useEmojiPacks";
import { useEventStore } from "@/hooks/useEventStore";
import { parseAddr } from "@/lib/parseAddr";

import type { NostrRumor } from "@/lib/nostrRumor";

export interface CustomEmoji {
  shortcode: string;
  url: string;
  /**
   * The `30030:pubkey:dtag` coordinate of the pack this emoji came from, when
   * it came from one. Absent for emojis inlined directly on the kind-10030
   * list. Drives the "which pack is this from?" affordances (per-pack picker
   * categories, the reaction detail popover).
   */
  packCoord?: string;
  /** The source pack's human name, resolved at read time for display. */
  packName?: string;
}

/**
 * Durable, per-user copy of the LAST resolved palette.
 *
 * This is the whole point of the hook's persistence: the React Query cache is
 * in-memory and wiped on every reload, so without a durable floor the picker
 * re-derives from a live two-hop relay read (10030 list → 30030 packs) on each
 * load and blanks whenever that read loses its race. localStorage is owned and
 * written here — not scavenged from the best-effort event cache — so a flaky
 * read can never lose emojis the user has already seen.
 */
function loadPalette(pubkey: string): CustomEmoji[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`armada:custom-emojis:${pubkey}`) ?? "");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function savePalette(pubkey: string, emojis: CustomEmoji[]): void {
  try {
    localStorage.setItem(`armada:custom-emojis:${pubkey}`, JSON.stringify(emojis));
  } catch {
    // localStorage full/unavailable — the in-memory result still stands.
  }
}

/** Newest event per addressable coordinate (`kind:pubkey:d`). */
function newestPerAddr(events: NostrRumor[]): NostrRumor[] {
  const newest = new Map<string, NostrRumor>();
  for (const event of events) {
    const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
    const addr = `${event.kind}:${event.pubkey}:${d}`;
    const prev = newest.get(addr);
    if (!prev || event.created_at > prev.created_at) newest.set(addr, event);
  }
  return [...newest.values()];
}

/**
 * Flatten a kind-10030 list plus its resolved kind-30030 packs into a deduped
 * palette. Inline `["emoji", …]` tags on the list and every pack's emoji tags
 * are merged; when the same shortcode maps to different URLs across packs it is
 * prefixed with the pack id so both stay reachable.
 */
function paletteFrom(listEvent: NostrRumor, packEvents: NostrRumor[]): CustomEmoji[] {
  const raw: {
    shortcode: string;
    url: string;
    packId: string;
    packCoord?: string;
    packName?: string;
  }[] = [];
  for (const t of listEvent.tags) {
    if (t[0] === "emoji" && t[1] && t[2]) raw.push({ shortcode: t[1], url: t[2], packId: "" });
  }
  for (const pack of packEvents) {
    const packId = pack.tags.find(([n]) => n === "d")?.[1] ?? "";
    const packCoord = emojiPackCoord(pack.pubkey, packId);
    const packName = emojiPackName(pack);
    for (const t of pack.tags) {
      if (t[0] === "emoji" && t[1] && t[2]) {
        raw.push({ shortcode: t[1], url: t[2], packId, packCoord, packName });
      }
    }
  }

  const urlsByCode = new Map<string, Set<string>>();
  for (const e of raw) {
    let urls = urlsByCode.get(e.shortcode);
    if (!urls) urlsByCode.set(e.shortcode, (urls = new Set()));
    urls.add(e.url);
  }

  const out: CustomEmoji[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    const code =
      urlsByCode.get(e.shortcode)!.size > 1 && e.packId ? `${e.packId}-${e.shortcode}` : e.shortcode;
    if (!seen.has(code)) {
      seen.add(code);
      out.push({ shortcode: code, url: e.url, packCoord: e.packCoord, packName: e.packName });
    }
  }
  return out;
}

/**
 * The current user's NIP-30 custom emoji palette (kind 10030 + referenced kind
 * 30030 packs), backed by a durable per-user localStorage copy.
 *
 * The read reconciles relay ∪ local store, but the rule is simple: a read only
 * REPLACES the stored palette when it produces something (or proves the list is
 * genuinely empty). Anything short — no list, or packs that didn't come back —
 * keeps the last durable palette instead of blanking the picker.
 */
export function useCustomEmojis() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();

  const query = useQuery({
    queryKey: ["custom-emojis", user?.pubkey ?? ""],
    enabled: !!user,
    // Show the durable palette instantly on mount; the read below reconciles.
    initialData: () => (user ? loadPalette(user.pubkey) : []),
    initialDataUpdatedAt: 0, // still stale, so mount triggers a reconcile
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    queryFn: async ({ signal }): Promise<CustomEmoji[]> => {
      if (!user) return [];
      const store = await eventStore;
      const floor = loadPalette(user.pubkey);

      const { event: list } = await readEmojiList(nostr, store, user.pubkey, accountDataRelays(config), signal);
      if (!list) return floor; // list read came up short — keep what we had

      const packRefs = list.tags
        .filter((t) => t[0] === "a" && t[1])
        .map((t) => parseAddr(t[1]))
        .filter((a): a is NonNullable<typeof a> => !!a && a.kind === 30030);

      let packEvents: NostrRumor[] = [];
      if (packRefs.length > 0) {
        const filters = packRefs.map((r) => ({
          kinds: [30030],
          authors: [r.pubkey],
          "#d": [r.identifier],
          limit: 1,
        }));
        const [relay, cached] = await Promise.all([
          nostr.query(filters, { signal }).catch(() => [] as NostrRumor[]),
          store.query(filters).catch(() => [] as NostrRumor[]),
        ]);
        packEvents = newestPerAddr([...relay, ...cached]);
      }

      const palette = paletteFrom(list, packEvents);

      // An empty result is only real when the list itself is empty (no inline
      // emojis, no pack refs). Empty DESPITE refs means the pack read came up
      // short — keep the durable floor rather than blank the picker.
      const listIsEmpty =
        packRefs.length === 0 && !list.tags.some((t) => t[0] === "emoji" && t[1] && t[2]);
      if (palette.length === 0 && !listIsEmpty) return floor;

      savePalette(user.pubkey, palette);
      return palette;
    },
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

import { useNostr } from "@nostrify/react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { parseAddr } from "@/lib/parseAddr";
import { KIND_USER_EMOJIS } from "@/lib/selfSyncKinds";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-30 emoji set (a shareable pack). */
export const KIND_EMOJI_SET = 30030;

/**
 * Whether a durable, reload-surviving palette exists for `pubkey`.
 *
 * `useCustomEmojis` owns `armada:custom-emojis:<pubkey>` in localStorage and
 * only writes it once a palette has actually resolved (never from a failed
 * read). It therefore answers "has this account ever had emojis?" across page
 * loads — the in-memory React Query caches are wiped on reload and are empty
 * exactly when a cold-start read is most likely to race out. The key is kept in
 * sync with `useCustomEmojis` by hand; we can't import it without a module
 * cycle (that hook already imports from here).
 */
function hasDurableEmojis(pubkey: string): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(`armada:custom-emojis:${pubkey}`) ?? "");
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** The outcome of reading the user's kind-10030 list. */
export interface EmojiListRead {
  /** Newest list from the relays or the local event store, if one was found. */
  event: NostrEvent | null;
  /**
   * Whether the read reached an EOSE at all, rather than being aborted or
   * timing out. This is a WEAK signal, and weaker than it looks: the pool runs
   * with `eoseTimeout` (300ms globally, widened here), so the merged EOSE fires
   * once the FIRST relay finishes plus the grace window — not once every routed
   * relay has answered. So `conclusive` means "a round completed", NOT "the
   * relay set proved there is no list". Never let it alone authorise blanking
   * or recreating a list; pair it with the local store and whatever is already
   * on screen.
   */
  conclusive: boolean;
}

/**
 * How long to keep listening after the first relay's EOSE.
 *
 * The pool's global `eoseTimeout` is 300ms (NostrProvider) — tuned for
 * timelines, where the fastest relay is representative of the rest. A user's
 * emoji list is a SINGLE replaceable event that may live on only one, slower
 * relay (and on a cold page load every socket is still connecting, possibly
 * mid-NIP-42), so 300ms routinely cuts it off and the palette comes up empty.
 * The batcher's ReplaceableCollector widens the same window to 1s for kind 0
 * for exactly this reason; a list that only loads sometimes is worth more
 * patience than that.
 */
const EMOJI_LIST_EOSE_GRACE_MS = 2500;

/** Hard ceiling, so a relay that never EOSEs can't hang the read forever. */
const EMOJI_LIST_READ_TIMEOUT_MS = 8000;

/**
 * Read the current user's kind-10030 list, newest of (relays, local store).
 *
 * Uses `req` rather than `query` so the EOSE is observable, and omits `limit`
 * so the filter doesn't match `isReplaceableFilter` — the batcher's
 * ReplaceableCollector merges replaceable kinds into one REQ and resolves at
 * the first EOSE, which races out a slow relay holding the 10030. The local
 * store is applied as a floor so a relay miss falls back to the last list we
 * actually observed, and events that arrived before an abort/timeout still
 * count (only `conclusive` is lost).
 */
export async function readEmojiList(
  nostr: ReturnType<typeof useNostr>["nostr"],
  store: Awaited<ReturnType<typeof useEventStore>>,
  pubkey: string,
  signal?: AbortSignal,
): Promise<EmojiListRead> {
  const filter = { kinds: [KIND_USER_EMOJIS], authors: [pubkey] };
  const deadline = AbortSignal.timeout(EMOJI_LIST_READ_TIMEOUT_MS);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  const relayEvents: NostrEvent[] = [];
  let conclusive = false;
  try {
    for await (const msg of nostr.req([filter], {
      signal: readSignal,
      eoseTimeout: EMOJI_LIST_EOSE_GRACE_MS,
    })) {
      if (msg[0] === "EVENT") relayEvents.push(msg[2]);
      else if (msg[0] === "EOSE") {
        conclusive = true;
        break;
      } else if (msg[0] === "CLOSED") break;
    }
  } catch {
    // Aborted or relay error — `conclusive` stays false, which is the point.
  }

  const cachedEvents = await store.query([filter]).catch(() => [] as NostrEvent[]);
  const event = [...relayEvents, ...cachedEvents]
    .sort((a, b) => b.created_at - a.created_at)[0] ?? null;

  return { event, conclusive };
}

/** The addressable coordinate of an emoji pack: `30030:pubkey:dtag`. */
export function emojiPackCoord(pubkey: string, identifier: string): string {
  return `${KIND_EMOJI_SET}:${pubkey}:${identifier}`;
}

/**
 * Whether the current user's kind 10030 list already references the emoji pack
 * at `coord` (`30030:pubkey:dtag`). Read-only; shares the custom-emoji cache
 * so it invalidates when a pack is added.
 */
export function useHasEmojiPack(coord: string | undefined): boolean {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  const { data } = useQuery({
    queryKey: ["emoji-pack-refs", user?.pubkey ?? ""],
    queryFn: async ({ signal }) => {
      if (!user) return [] as string[];
      const store = await eventStore;
      // Same store floor as the mutation: a missed read here would label an
      // already-added pack "Add", inviting the write that then rebuilds the list.
      const { event: list } = await readEmojiList(nostr, store, user.pubkey, signal);
      if (!list) return [] as string[];
      return list.tags.filter((t) => t[0] === "a" && t[1]).map((t) => t[1]);
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });

  return !!coord && (data?.includes(coord) ?? false);
}

/**
 * Add a NIP-30 emoji pack (kind 30030) to the current user's emoji list
 * (kind 10030) by appending its `["a", "30030:pubkey:dtag"]` coordinate.
 *
 * Kind 10030 is a public NIP-51 list, so no encryption is needed. The freshest
 * list is fetched first so we append rather than overwrite, and the pack's
 * relay hint (if any) is carried on the `a` tag. On success both the emoji-pack
 * ref cache and the merged custom-emoji cache are invalidated so the new pack's
 * emojis become usable immediately.
 *
 * The mutation refuses to publish when the list can't be read but we hold
 * evidence one exists — appending to an empty base would replace the user's
 * emoji list everywhere rather than adding to it.
 */
export function useAddEmojiPack(): UseMutationResult<
  void,
  Error,
  { pubkey: string; identifier: string; relay?: string }
> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();

  return useMutation({
    mutationFn: async ({ pubkey, identifier, relay }) => {
      if (!user) throw new Error("Sign in to add an emoji pack.");

      const coord = emojiPackCoord(pubkey, identifier);
      const store = await eventStore;

      // Fetch the freshest list so we append rather than clobber it.
      const { event: prev, conclusive } = await readEmojiList(
        nostr,
        store,
        user.pubkey,
        AbortSignal.timeout(15_000),
      );

      // Never publish a list built from an empty base. Kind 10030 is
      // replaceable, so doing that on a read that merely FAILED replaces every
      // emoji the user has with this one pack. Creating the list from scratch
      // is only allowed when a relay completed the read (EOSE) and reported
      // nothing, the local store has nothing, and no local record — durable or
      // in-memory — says a list ever existed. Short of that we publish nothing
      // and say so.
      const base = prev;
      if (!base) {
        const knownRefs = queryClient.getQueryData<string[]>(["emoji-pack-refs", user.pubkey]);
        const knownEmojis = queryClient.getQueryData<unknown[]>(["custom-emojis", user.pubkey]);
        // The durable localStorage palette is the reload-surviving evidence a
        // list exists (AGENTS.md: "refuse to build on an empty/failed read when
        // local persisted state says a non-empty list existed"). It is what
        // makes a single conclusive read safe enough to build a first list on,
        // so we don't need a second, identical re-read — one the replaceable
        // batcher tends to collapse into a no-EOSE hang, which used to make the
        // very first add impossible.
        const seenAList =
          (knownRefs?.length ?? 0) > 0 ||
          (knownEmojis?.length ?? 0) > 0 ||
          hasDurableEmojis(user.pubkey);
        if (!conclusive || seenAList) {
          throw new Error("Couldn't read your emoji list. Check your connection and try again.");
        }
        // base stays null → create the user's first list from scratch.
      }

      const tags: string[][] = base ? base.tags.map((t) => [...t]) : [];

      // Already added? Nothing to do.
      if (tags.some((t) => t[0] === "a" && t[1] === coord)) return;

      tags.push(relay ? ["a", coord, relay] : ["a", coord]);

      await publish.mutateAsync({
        kind: KIND_USER_EMOJIS,
        content: base?.content ?? "",
        tags,
        prev: base ?? undefined,
      });

      void queryClient.invalidateQueries({ queryKey: ["emoji-pack-refs"] });
      void queryClient.invalidateQueries({ queryKey: ["custom-emojis"] });
      void queryClient.invalidateQueries({ queryKey: ["my-emoji-packs"] });
    },
  });
}

/**
 * Remove a NIP-30 emoji pack from the current user's kind-10030 list by
 * stripping its `["a", "30030:pubkey:dtag"]` coordinate. Read-modify-write, so
 * inline emojis and every other referenced pack are preserved.
 *
 * Removal never creates a list from scratch — it only ever publishes a strictly
 * smaller version of a list we actually read back. It therefore refuses to
 * publish when the list can't be read but evidence says one exists: republishing
 * an empty base would wipe every emoji rather than remove one pack (AGENTS.md
 * "Never publish a user's Nostr lists without an explicit user action"). When a
 * relay conclusively reports no list, there is genuinely nothing to remove and
 * the mutation is a silent no-op.
 */
export function useRemoveEmojiPack(): UseMutationResult<void, Error, { coord: string }> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();

  return useMutation({
    mutationFn: async ({ coord }) => {
      if (!user) throw new Error("Sign in to manage emoji packs.");

      const store = await eventStore;

      // Fetch the freshest list so we edit the real thing, not a stale copy.
      const { event: prev, conclusive } = await readEmojiList(
        nostr,
        store,
        user.pubkey,
        AbortSignal.timeout(15_000),
      );

      if (!prev) {
        // No list came back. Treating that as "already empty, nothing to
        // remove" is only safe when a relay actually completed the read AND
        // nothing we hold says a list exists — otherwise a failed read would
        // silently report success at removing nothing (and leave the pack in
        // place on the network). Short of that, surface the failure.
        const knownRefs = queryClient.getQueryData<string[]>(["emoji-pack-refs", user.pubkey]);
        const knownEmojis = queryClient.getQueryData<unknown[]>(["custom-emojis", user.pubkey]);
        const seenAList =
          (knownRefs?.length ?? 0) > 0 ||
          (knownEmojis?.length ?? 0) > 0 ||
          hasDurableEmojis(user.pubkey);
        if (!conclusive || seenAList) {
          throw new Error("Couldn't read your emoji list. Check your connection and try again.");
        }
        return; // genuinely nothing to remove
      }

      // Not referenced? Nothing to do.
      if (!prev.tags.some((t) => t[0] === "a" && t[1] === coord)) return;

      const tags = prev.tags.filter((t) => !(t[0] === "a" && t[1] === coord));

      await publish.mutateAsync({
        kind: KIND_USER_EMOJIS,
        content: prev.content,
        tags,
        prev,
      });

      void queryClient.invalidateQueries({ queryKey: ["emoji-pack-refs"] });
      void queryClient.invalidateQueries({ queryKey: ["custom-emojis"] });
      void queryClient.invalidateQueries({ queryKey: ["my-emoji-packs"] });
    },
  });
}

/** A pack referenced by the user's kind-10030 list, with its resolved event. */
export interface MyEmojiPack {
  /** The `30030:pubkey:dtag` coordinate from the user's list. */
  coord: string;
  /** Relay hint carried on the `a` tag, if any. */
  relay?: string;
  /** The resolved kind-30030 event, or null if it couldn't be fetched. */
  event: NostrEvent | null;
}

/**
 * The emoji packs the current user has added (kind-10030 `["a", …]` refs
 * resolved to their kind-30030 events), for a management UI. Unresolved packs
 * are still returned (with `event: null`) so a pack whose set didn't load can
 * still be listed and removed by coordinate.
 */
export function useMyEmojiPacks(): UseQueryResult<MyEmojiPack[]> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  return useQuery({
    queryKey: ["my-emoji-packs", user?.pubkey ?? ""],
    enabled: !!user,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<MyEmojiPack[]> => {
      if (!user) return [];
      const store = await eventStore;

      const { event: list } = await readEmojiList(nostr, store, user.pubkey, signal);
      if (!list) return [];

      const refs = list.tags
        .filter((t) => t[0] === "a" && t[1])
        .map((t) => ({ coord: t[1], relay: t[2] as string | undefined, addr: parseAddr(t[1]) }))
        .filter((r) => !!r.addr && r.addr.kind === KIND_EMOJI_SET);
      if (refs.length === 0) return [];

      const filters = refs.map((r) => ({
        kinds: [KIND_EMOJI_SET],
        authors: [r.addr!.pubkey],
        "#d": [r.addr!.identifier],
        limit: 1,
      }));
      const [relay, cached] = await Promise.all([
        nostr.query(filters, { signal }).catch(() => [] as NostrEvent[]),
        store.query(filters).catch(() => [] as NostrEvent[]),
      ]);

      const byCoord = new Map<string, NostrEvent>();
      for (const ev of [...relay, ...cached]) {
        const d = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
        const coord = emojiPackCoord(ev.pubkey, d);
        const existing = byCoord.get(coord);
        if (!existing || ev.created_at > existing.created_at) byCoord.set(coord, ev);
      }

      return refs.map((r) => ({
        coord: r.coord,
        relay: r.relay,
        event: byCoord.get(r.coord) ?? null,
      }));
    },
  });
}

/** Extract the `["emoji", shortcode, url]` mappings from a kind 30030 event. */
export function emojiPackEntries(event: NostrEvent): { shortcode: string; url: string }[] {
  return event.tags
    .filter((t) => t[0] === "emoji" && t[1] && t[2])
    .map((t) => ({ shortcode: t[1], url: t[2] }));
}

/**
 * The pack's human name. Reads `title` and `name` (clients disagree on which
 * they emit — we publish both), falling back to the `d` identifier.
 */
export function emojiPackName(event: NostrEvent): string {
  return (
    event.tags.find((t) => t[0] === "title")?.[1] ||
    event.tags.find((t) => t[0] === "name")?.[1] ||
    event.tags.find((t) => t[0] === "d")?.[1] ||
    "Emoji pack"
  );
}

/** The pack's description (`about` tag), if any. */
export function emojiPackAbout(event: NostrEvent): string | undefined {
  return event.tags.find((t) => t[0] === "about")?.[1] || undefined;
}

/** The pack's cover image (`image` or `picture` tag), if any. */
export function emojiPackPicture(event: NostrEvent): string | undefined {
  return (
    event.tags.find((t) => t[0] === "image")?.[1] ||
    event.tags.find((t) => t[0] === "picture")?.[1] ||
    undefined
  );
}

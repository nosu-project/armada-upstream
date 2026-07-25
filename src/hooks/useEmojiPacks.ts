import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_USER_EMOJIS } from "@/lib/selfSyncKinds";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-30 emoji set (a shareable pack). */
export const KIND_EMOJI_SET = 30030;

/** The outcome of reading the user's kind-10030 list. */
interface EmojiListRead {
  /** Newest list from the relays or the local event store, if one was found. */
  event: NostrEvent | null;
  /**
   * Whether the read actually completed. `NPool.req` yields `EOSE` only after
   * every routed relay has sent one (and `CLOSED` only after every relay
   * closed), so `conclusive` means the full relay set reported
   * end-of-stored-events. `NPool.query` can't provide this: it wraps its read
   * loop in `try {} catch {}`, so an abort, a dead socket and a genuinely
   * empty result are all just `[]`. Absence is never provable on Nostr, but
   * this is the difference between "the relays told us there is nothing" and
   * "we learned nothing".
   */
  conclusive: boolean;
}

/**
 * Read the current user's kind-10030 list, newest of (relays, local store).
 *
 * Uses `req` rather than `query` so the EOSE is observable, and omits `limit`
 * so the filter doesn't match `isReplaceableFilter` — the batcher's
 * ReplaceableCollector merges replaceable kinds into one REQ and resolves at
 * the first EOSE, which races out a slow relay holding the 10030. The local
 * store is applied as a floor so a relay miss falls back to the last list we
 * actually observed.
 */
async function readEmojiList(
  nostr: ReturnType<typeof useNostr>["nostr"],
  store: Awaited<ReturnType<typeof useEventStore>>,
  pubkey: string,
  signal?: AbortSignal,
): Promise<EmojiListRead> {
  const filter = { kinds: [KIND_USER_EMOJIS], authors: [pubkey] };

  const relayEvents: NostrEvent[] = [];
  let conclusive = false;
  try {
    for await (const msg of nostr.req([filter], { signal })) {
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
      // is only allowed when a relay completed the read and reported nothing,
      // the local store has nothing, and nothing we've already rendered says
      // otherwise. Short of all three we publish nothing and say so.
      if (!prev) {
        const knownRefs = queryClient.getQueryData<string[]>(["emoji-pack-refs", user.pubkey]);
        const knownEmojis = queryClient.getQueryData<unknown[]>(["custom-emojis", user.pubkey]);
        const seenAList = (knownRefs?.length ?? 0) > 0 || (knownEmojis?.length ?? 0) > 0;
        if (!conclusive || seenAList) {
          throw new Error("Couldn't read your emoji list. Check your connection and try again.");
        }
      }

      const tags: string[][] = prev ? prev.tags.map((t) => [...t]) : [];

      // Already added? Nothing to do.
      if (tags.some((t) => t[0] === "a" && t[1] === coord)) return;

      tags.push(relay ? ["a", coord, relay] : ["a", coord]);

      await publish.mutateAsync({
        kind: KIND_USER_EMOJIS,
        content: prev?.content ?? "",
        tags,
        prev: prev ?? undefined,
      });

      void queryClient.invalidateQueries({ queryKey: ["emoji-pack-refs"] });
      void queryClient.invalidateQueries({ queryKey: ["custom-emojis"] });
    },
  });
}

/** Extract the `["emoji", shortcode, url]` mappings from a kind 30030 event. */
export function emojiPackEntries(event: NostrEvent): { shortcode: string; url: string }[] {
  return event.tags
    .filter((t) => t[0] === "emoji" && t[1] && t[2])
    .map((t) => ({ shortcode: t[1], url: t[2] }));
}

/** The pack's human name (`title` tag), falling back to its `d` identifier. */
export function emojiPackName(event: NostrEvent): string {
  return (
    event.tags.find((t) => t[0] === "title")?.[1] ||
    event.tags.find((t) => t[0] === "d")?.[1] ||
    "Emoji pack"
  );
}

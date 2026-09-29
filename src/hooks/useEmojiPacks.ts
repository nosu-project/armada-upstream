import { useNostr } from "@nostrify/react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { accountDataRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { hasDurableEmojis } from "@/lib/emojiPalette";
import { parseAddr } from "@/lib/parseAddr";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { KIND_USER_EMOJIS } from "@/lib/selfSyncKinds";

import type { NostrRumor } from "@/lib/nostrRumor";

export const KIND_EMOJI_SET = 30030;

export interface EmojiListRead {
  event: NostrRumor | null;
  /**
   * Whether the read reached EOSE. `NPool.req` only emits the merged EOSE once EVERY routed
   * relay has, so this is reliable only because the read is scoped to account-data relays.
   * Not proof of absence: never let it alone authorise blanking or recreating a list.
   */
  conclusive: boolean;
}

/**
 * Grace after the first EOSE. The pool's 300ms `eoseTimeout` routinely cuts off the one
 * slower relay holding this single replaceable event.
 */
const EMOJI_LIST_EOSE_GRACE_MS = 2500;

const EMOJI_LIST_READ_TIMEOUT_MS = 8000;

/**
 * Kind-10030 list, newest of (relays, local store floor).
 * Uses `req` (observable EOSE) without `limit` so the batcher's ReplaceableCollector doesn't
 * merge it and resolve at the first EOSE. `relays` scopes to account-data relays, which is
 * load-bearing for `conclusive` (see {@link EmojiListRead}). Empty → default pool routing.
 */
export async function readEmojiList(
  nostr: ReturnType<typeof useNostr>["nostr"],
  store: Awaited<ReturnType<typeof useEventStore>>,
  pubkey: string,
  relays: string[],
  signal?: AbortSignal,
): Promise<EmojiListRead> {
  const filter = { kinds: [KIND_USER_EMOJIS], authors: [pubkey] };
  const deadline = AbortSignal.timeout(EMOJI_LIST_READ_TIMEOUT_MS);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

  const relayEvents: NostrRumor[] = [];
  let conclusive = false;
  try {
    for await (const msg of nostr.req([filter], {
      signal: readSignal,
      eoseTimeout: EMOJI_LIST_EOSE_GRACE_MS,
      ...(relays.length ? { relays } : {}),
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

  const cachedEvents = await store.query([filter]).catch(() => [] as NostrRumor[]);
  const event = [...relayEvents, ...cachedEvents]
    .sort((a, b) => b.created_at - a.created_at)[0] ?? null;

  return { event, conclusive };
}

export function emojiPackCoord(pubkey: string, identifier: string): string {
  return `${KIND_EMOJI_SET}:${pubkey}:${identifier}`;
}

/**
 * Whether the user's kind-10030 list references the pack at `coord`. Shares the
 * custom-emoji cache so it invalidates on add.
 */
export function useHasEmojiPack(coord: string | undefined): boolean {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();

  const { data } = useQuery({
    queryKey: ["emoji-pack-refs", user?.pubkey ?? ""],
    queryFn: async ({ signal }) => {
      if (!user) return [] as string[];
      const store = await eventStore;
      // Same store floor as the mutation, or a missed read would invite a list rebuild.
      const { event: list } = await readEmojiList(nostr, store, user.pubkey, accountDataRelays(config), signal);
      if (!list) return [] as string[];
      return list.tags.filter((t) => t[0] === "a" && t[1]).map((t) => t[1]);
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });

  return !!coord && (data?.includes(coord) ?? false);
}

/**
 * Add a NIP-30 pack to the user's kind-10030 list (read-modify-write append of its
 * `a` coordinate). Refuses to publish when the read failed but a list is known to exist —
 * an empty base would replace the user's list everywhere.
 */
export function useAddEmojiPack(): UseMutationResult<
  void,
  Error,
  { pubkey: string; identifier: string; relay?: string }
> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();

  return useMutation({
    mutationFn: async ({ pubkey, identifier, relay }) => {
      if (!user) throw new Error("Sign in to add an emoji pack.");

      const coord = emojiPackCoord(pubkey, identifier);
      const store = await eventStore;

      const { event: prev, conclusive } = await readEmojiList(
        nostr,
        store,
        user.pubkey,
        accountDataRelays(config),
        AbortSignal.timeout(15_000),
      );

      // Never publish from an empty base on a FAILED read (10030 is replaceable). Create from
      // scratch only on a conclusive empty read with no local evidence of a list.
      const base = prev;
      if (!base) {
        const knownRefs = queryClient.getQueryData<string[]>(["emoji-pack-refs", user.pubkey]);
        const knownEmojis = queryClient.getQueryData<unknown[]>(["custom-emojis", user.pubkey]);
        // The durable palette is the reload-surviving evidence a list exists (AGENTS.md), which
        // makes a single conclusive read safe.
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
 * Remove a pack's `a` coordinate from the kind-10030 list. Never creates a list; refuses
 * when the read failed but a list is known to exist (AGENTS.md). Conclusive no list → no-op.
 */
export function useRemoveEmojiPack(): UseMutationResult<void, Error, { coord: string }> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();

  return useMutation({
    mutationFn: async ({ coord }) => {
      if (!user) throw new Error("Sign in to manage emoji packs.");

      const store = await eventStore;

      const { event: prev, conclusive } = await readEmojiList(
        nostr,
        store,
        user.pubkey,
        accountDataRelays(config),
        AbortSignal.timeout(15_000),
      );

      if (!prev) {
        // "Nothing to remove" is only safe on a conclusive read with no evidence of a list;
        // otherwise surface the failure.
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

export interface MyEmojiPack {
  coord: string;
  relay?: string;
  /** null if it couldn't be fetched. */
  event: NostrRumor | null;
}

/**
 * Packs the user added, resolved to kind-30030 events; unresolved ones are returned with
 * `event: null` so they can still be removed.
 */
export function useMyEmojiPacks(): UseQueryResult<MyEmojiPack[]> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();

  return useQuery({
    queryKey: ["my-emoji-packs", user?.pubkey ?? ""],
    enabled: !!user,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<MyEmojiPack[]> => {
      if (!user) return [];
      const store = await eventStore;

      const { event: list } = await readEmojiList(nostr, store, user.pubkey, accountDataRelays(config), signal);
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
        nostr.query(filters, { signal }).catch(() => [] as NostrRumor[]),
        store.query(filters).catch(() => [] as NostrRumor[]),
      ]);

      const byCoord = newestPerCoord([...relay, ...cached]);

      return refs.map((r) => ({
        coord: r.coord,
        relay: r.relay,
        event: byCoord.get(r.coord) ?? null,
      }));
    },
  });
}

/** Newest event per `kind:pubkey:d`. */
function newestPerCoord(events: NostrRumor[]): Map<string, NostrRumor> {
  const byCoord = new Map<string, NostrRumor>();
  for (const ev of events) {
    const d = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
    const coord = emojiPackCoord(ev.pubkey, d);
    const existing = byCoord.get(coord);
    if (!existing || ev.created_at > existing.created_at) byCoord.set(coord, ev);
  }
  return byCoord;
}

/**
 * The newest copy of one of the user's own packs, relays and local store merged. An edit
 * builds on this rather than on whatever event opened the editor, so tags another client
 * added since are preserved.
 */
export async function readOwnEmojiPack(
  nostr: ReturnType<typeof useNostr>["nostr"],
  store: Awaited<ReturnType<typeof useEventStore>>,
  pubkey: string,
  identifier: string,
  signal?: AbortSignal,
): Promise<NostrRumor | null> {
  const filters = [{ kinds: [KIND_EMOJI_SET], authors: [pubkey], "#d": [identifier], limit: 1 }];
  const [relay, cached] = await Promise.all([
    nostr.query(filters, { signal }).catch(() => [] as NostrRumor[]),
    store.query(filters).catch(() => [] as NostrRumor[]),
  ]);
  return [...relay, ...cached].sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/**
 * Packs the user authored (kind 30030), newest first. Distinct from {@link useMyEmojiPacks}:
 * a pack can be published, added to the 10030 list, or both.
 */
export function useMyPublishedPacks(): UseQueryResult<MyEmojiPack[]> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();

  return useQuery({
    queryKey: ["my-published-packs", user?.pubkey ?? ""],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<MyEmojiPack[]> => {
      if (!user) return [];
      const store = await eventStore;
      const filters = [{ kinds: [KIND_EMOJI_SET], authors: [user.pubkey], limit: 100 }];
      const [relay, cached] = await Promise.all([
        nostr.query(filters, { signal }).catch(() => [] as NostrRumor[]),
        store.query(filters).catch(() => [] as NostrRumor[]),
      ]);
      return [...newestPerCoord([...relay, ...cached]).entries()]
        .map(([coord, event]) => ({ coord, event }))
        .sort((a, b) => b.event.created_at - a.event.created_at);
    },
  });
}

export function emojiPackEntries(event: NostrRumor): { shortcode: string; url: string }[] {
  return event.tags
    .filter((t) => t[0] === "emoji" && t[1] && t[2])
    .map((t) => ({ shortcode: t[1], url: t[2] }));
}

/** Reads `title` and `name` (clients disagree; we publish both), falling back to `d`. */
export function emojiPackName(event: NostrRumor): string {
  return (
    event.tags.find((t) => t[0] === "title")?.[1] ||
    event.tags.find((t) => t[0] === "name")?.[1] ||
    event.tags.find((t) => t[0] === "d")?.[1] ||
    "Emoji pack"
  );
}

export function emojiPackAbout(event: NostrRumor): string | undefined {
  return event.tags.find((t) => t[0] === "about")?.[1] || undefined;
}

/** Checked here so a stranger's pack cannot point viewers' browsers at a private address. */
export function emojiPackPicture(event: NostrRumor): string | undefined {
  return sanitizeImageSrc(
    event.tags.find((t) => t[0] === "image")?.[1] ||
    event.tags.find((t) => t[0] === "picture")?.[1] ||
    undefined
  );
}

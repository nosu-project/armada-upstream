import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { accountDataRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { emojiPackCoord, emojiPackName, KIND_EMOJI_SET } from "@/hooks/useEmojiPacks";
import { useEventStore } from "@/hooks/useEventStore";
import {
  KIND_RELAY_LIST,
  newestRelayList,
  parseRelayList,
  queryExplicitRelays,
} from "@/lib/nip65";
import { parseAddr } from "@/lib/parseAddr";
import { KIND_USER_EMOJIS } from "@/lib/selfSyncKinds";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface EmojiSource {
  /** `30030:pubkey:dtag`. */
  coord: string;
  name: string;
  pubkey: string;
  identifier: string;
}

const STORE_PACK_LIMIT = 500;

/**
 * Index local kind-30030 packs by emoji URL. No network query on purpose: an emoji tag
 * names no pack and relays can't filter by URL.
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
        .catch(() => [] as NostrRumor[]);

      // Newest event per coordinate, so an edited pack resolves to its current name.
      const newest = new Map<string, NostrRumor>();
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
          // First pack to claim a URL keeps it.
          if (t[0] === "emoji" && t[2] && !index.has(t[2])) index.set(t[2], source);
        }
      }
      return index;
    },
  });
}

const REMOTE_LOOKUP_TIMEOUT_MS = 6000;

/**
 * After the first relay answers, wait at most this long for the rest; a pack is one
 * addressable event.
 */
const RELAY_GRACE_MS = 1200;

/** Pure, so the resolver can match early and skip remaining hops. */
function matchPackUrl(
  events: (NostrEvent | NostrRumor)[],
  url: string,
): EmojiSource | undefined {
  const newest = new Map<string, NostrEvent | NostrRumor>();
  for (const ev of events) {
    if (ev.kind !== KIND_EMOJI_SET) continue;
    const identifier = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
    const coord = emojiPackCoord(ev.pubkey, identifier);
    const prev = newest.get(coord);
    if (!prev || ev.created_at > prev.created_at) newest.set(coord, ev);
  }
  for (const [coord, ev] of newest) {
    if (!ev.tags.some((t) => t[0] === "emoji" && t[2] === url)) continue;
    const identifier = ev.tags.find(([n]) => n === "d")?.[1] ?? "";
    return { coord, name: emojiPackName(ev), pubkey: ev.pubkey, identifier };
  }
  return undefined;
}

/**
 * Resolve an emoji's pack via its author's relays (their authored packs or 10030 refs),
 * returning as soon as a pack claims `url`:
 * 1. local store + seed relays for 10002, authored 30030s and 10030;
 * 2. the author's NIP-65 write relays, if new;
 * 3. the 10030 refs via write relays/hints/seed, then each pack author's write relays.
 * Fetched packs are cached into the store. Undefined when nothing claims `url`.
 */
async function resolveEmojiSourceFromAuthor(
  nostr: ReturnType<typeof useNostr>["nostr"],
  store: Awaited<ReturnType<typeof useEventStore>>,
  authorPubkey: string,
  url: string,
  seedRelays: string[],
  signal: AbortSignal,
): Promise<EmojiSource | undefined> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(REMOTE_LOOKUP_TIMEOUT_MS)]);
  const grace = { graceMs: RELAY_GRACE_MS };

  const authoredFilter = { kinds: [KIND_EMOJI_SET], authors: [authorPubkey], limit: 100 };
  const listFilter = { kinds: [KIND_USER_EMOJIS], authors: [authorPubkey], limit: 1 };
  const relayListFilter = { kinds: [KIND_RELAY_LIST], authors: [authorPubkey], limit: 1 };

  const cachePacks = (events: NostrEvent[]) => {
    for (const ev of events) {
      if (ev.kind === KIND_EMOJI_SET) void Promise.resolve(store.event(ev)).catch(() => {});
    }
  };

  const [seedEvents, cachedOwn] = await Promise.all([
    queryExplicitRelays(
      nostr,
      seedRelays,
      [authoredFilter, listFilter, relayListFilter],
      deadline,
      grace,
    ).catch(() => [] as NostrEvent[]),
    store.query([authoredFilter, listFilter]).catch(() => [] as NostrRumor[]),
  ]);
  cachePacks(seedEvents);

  const gathered: (NostrEvent | NostrRumor)[] = [...seedEvents, ...cachedOwn];
  const ownPacks = () => gathered.filter((e) => e.kind === KIND_EMOJI_SET && e.pubkey === authorPubkey);

  const early = matchPackUrl(ownPacks(), url);
  if (early) return early;

  const relayListEvent = newestRelayList(
    gathered.filter(
      (e): e is NostrEvent => e.kind === KIND_RELAY_LIST && e.pubkey === authorPubkey,
    ),
  );
  const authorWriteRelays = relayListEvent
    ? parseRelayList(relayListEvent).filter((r) => r.write).map((r) => r.url)
    : [];

  const newWriteRelays = authorWriteRelays.filter((u) => !seedRelays.includes(u));
  if (newWriteRelays.length > 0) {
    const more = await queryExplicitRelays(nostr, newWriteRelays, [authoredFilter], deadline, grace)
      .catch(() => [] as NostrEvent[]);
    cachePacks(more);
    gathered.push(...more.filter((e) => e.pubkey === authorPubkey));
    const hit = matchPackUrl(ownPacks(), url);
    if (hit) return hit;
  }

  const list = gathered
    .filter((e) => e.kind === KIND_USER_EMOJIS && e.pubkey === authorPubkey)
    .sort((a, b) => b.created_at - a.created_at)[0];
  const refs = (list?.tags ?? [])
    .filter((t) => t[0] === "a" && t[1])
    .map((t) => ({ relayHint: t[2] as string | undefined, addr: parseAddr(t[1]) }))
    .filter((r) => !!r.addr && r.addr.kind === KIND_EMOJI_SET);
  if (refs.length === 0) return undefined;

  const packFilters = refs.map((r) => ({
    kinds: [KIND_EMOJI_SET],
    authors: [r.addr!.pubkey],
    "#d": [r.addr!.identifier],
    limit: 1,
  }));

  // Known relays first (author write relays, ref hints, seed, local store).
  const directReadSet = new Set<string>([...authorWriteRelays, ...seedRelays]);
  for (const r of refs) if (r.relayHint) directReadSet.add(r.relayHint);
  const [refDirect, cachedRefs] = await Promise.all([
    queryExplicitRelays(nostr, directReadSet, packFilters, deadline, grace).catch(
      () => [] as NostrEvent[],
    ),
    store.query(packFilters).catch(() => [] as NostrRumor[]),
  ]);
  cachePacks(refDirect);
  gathered.push(...refDirect, ...cachedRefs);
  const direct = matchPackUrl(gathered, url);
  if (direct) return direct;

  // Last resort: each pack author's write relays.
  const packAuthors = [...new Set(refs.map((r) => r.addr!.pubkey))];
  const packAuthorRelayLists = await queryExplicitRelays(
    nostr,
    directReadSet,
    [{ kinds: [KIND_RELAY_LIST], authors: packAuthors }],
    deadline,
    grace,
  ).catch(() => [] as NostrEvent[]);
  const packReadSet = new Set<string>();
  for (const author of packAuthors) {
    const rl = newestRelayList(packAuthorRelayLists.filter((e) => e.pubkey === author));
    if (rl) for (const r of parseRelayList(rl)) if (r.write) packReadSet.add(r.url);
  }
  if (packReadSet.size === 0) return undefined;

  const refPacks = await queryExplicitRelays(nostr, packReadSet, packFilters, deadline, grace).catch(
    () => [] as NostrEvent[],
  );
  cachePacks(refPacks);
  gathered.push(...refPacks);
  return matchPackUrl(gathered, url);
}

/**
 * Which NIP-30 pack a custom emoji came from: own palette, then local index, then (with
 * `authorPubkey`) an author-scoped relay lookup. Mounted only in an open popover, so it's a
 * per-click cost.
 */
export interface EmojiSourceResult {
  source: EmojiSource | undefined;
  isLoading: boolean;
}

export function useEmojiSource(
  url: string | undefined,
  authorPubkey?: string,
): EmojiSourceResult {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const { emojis } = useCustomEmojis();
  const { data: index, isPending: indexPending } = usePackIndex();

  const local = useMemo(() => {
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

  // Wait for the local index to settle, or a cold index would fire the network needlessly.
  const remoteEnabled = !!url && !!authorPubkey && !indexPending && !local;
  const { data: remote, isFetching, isFetched } = useQuery({
    queryKey: ["emoji-source-remote", url ?? "", authorPubkey ?? ""],
    enabled: remoteEnabled,
    staleTime: 30 * 60_000,
    queryFn: async ({ signal }): Promise<EmojiSource | null> => {
      const store = await eventStore;
      const source = await resolveEmojiSourceFromAuthor(
        nostr,
        store,
        authorPubkey!,
        url!,
        accountDataRelays(config),
        signal,
      );
      return source ?? null;
    },
  });

  const source = local ?? remote ?? undefined;

  // "Loading" covers: index still building, remote query enabled but not yet fetched
  // (`isFetching` is false on the render `enabled` flips), and background refetch of a cached `null`.
  const wantsRemote = !!url && !!authorPubkey && !local;
  const isLoading =
    !source && wantsRemote && (indexPending || isFetching || (remoteEnabled && !isFetched));
  return { source, isLoading };
}

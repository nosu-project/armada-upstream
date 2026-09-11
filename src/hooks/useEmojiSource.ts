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
        .catch(() => [] as NostrRumor[]);

      // Newest event per coordinate wins, so a renamed/edited pack resolves to
      // its current name rather than whichever revision the cursor hit first.
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
          // First pack to claim a URL keeps it: an emoji copied into a later
          // pack shouldn't reattribute the original.
          if (t[0] === "emoji" && t[2] && !index.has(t[2])) index.set(t[2], source);
        }
      }
      return index;
    },
  });
}

/** Overall budget for one on-demand author-scoped resolution. */
const REMOTE_LOOKUP_TIMEOUT_MS = 6000;

/**
 * Once the first relay in a fan-out answers, wait at most this long for the
 * rest before proceeding with whatever landed. Without it each hop below waits
 * for EVERY routed relay to EOSE (or the full deadline), so one cold/slow relay
 * in the set paces the whole lookup. A pack is a single addressable event, so
 * the first relay that has it is enough.
 */
const RELAY_GRACE_MS = 1200;

/**
 * Newest kind-30030 per coordinate that CLAIMS `url`, as an `EmojiSource`. Pure;
 * takes whatever events have been gathered so far so the resolver can match
 * early and short-circuit the remaining network hops.
 */
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
 * Resolve an emoji's pack over the network, scoped to the message/reaction
 * author's own relays rather than a blind pool fan-out.
 *
 * A `["emoji", code, url]` tag names no pack, so the only principled way to find
 * one is through the person who USED it: any custom emoji they typed comes from
 * a pack their kind-10030 list references OR a pack they authored themselves.
 *
 * Ordered for the common case in the fewest hops, matching the URL after each
 * step and returning the moment a pack claims it:
 *   1. ONE combined round — the local store plus a single fan-out to the seed
 *      (account-data + pool) relays for the author's relay list (10002), the
 *      packs they AUTHORED (30030) and their 10030 list. In a shared-relay
 *      community the author's own pack is usually right here, so this resolves
 *      the whole lookup in a single hop.
 *   2. On a miss, escalate to the author's declared WRITE relays (discovered in
 *      step 1) for their authored packs, if that set adds anything new.
 *   3. Still missing, resolve the 10030 refs: read each referenced pack from the
 *      author's write relays + the ref's own relay hint + seed, and only if
 *      THAT misses discover each pack author's write relays and read there.
 *
 * Every fan-out carries a grace window ({@link RELAY_GRACE_MS}) so a slow relay
 * can't pace a hop. Freshly-fetched packs are written into the local store so
 * the synchronous {@link usePackIndex} warms up and a repeat needs no network.
 * Returns undefined when nothing the author can be tied to claims `url` — the
 * caller then renders no attribution rather than a guess.
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

  // Persist any relay-fetched 30030 so the local index warms for next time.
  const cachePacks = (events: NostrEvent[]) => {
    for (const ev of events) {
      if (ev.kind === KIND_EMOJI_SET) void Promise.resolve(store.event(ev)).catch(() => {});
    }
  };

  // 1. One combined round: seed relays + local store, in parallel.
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

  // The author's declared write relays, from the 10002 the first round saw.
  const relayListEvent = newestRelayList(
    gathered.filter(
      (e): e is NostrEvent => e.kind === KIND_RELAY_LIST && e.pubkey === authorPubkey,
    ),
  );
  const authorWriteRelays = relayListEvent
    ? parseRelayList(relayListEvent).filter((r) => r.write).map((r) => r.url)
    : [];

  // 2. Their authored packs from any write relays the seed round didn't cover.
  const newWriteRelays = authorWriteRelays.filter((u) => !seedRelays.includes(u));
  if (newWriteRelays.length > 0) {
    const more = await queryExplicitRelays(nostr, newWriteRelays, [authoredFilter], deadline, grace)
      .catch(() => [] as NostrEvent[]);
    cachePacks(more);
    gathered.push(...more.filter((e) => e.pubkey === authorPubkey));
    const hit = matchPackUrl(ownPacks(), url);
    if (hit) return hit;
  }

  // 3. The 10030 refs — packs the author ADDED but didn't author themselves.
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

  // First try the relays we already know: the author's write relays, each ref's
  // own NIP-51 relay hint, the seed set, and the local store — no extra
  // discovery hop. This resolves an added pack whenever the hint is present or
  // the pack lives where the author's account data does.
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

  // Last resort: discover each referenced PACK author's write relays and read
  // there. Only reached when the hint was absent and the pack isn't on any
  // relay we already had.
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
 * Resolve which NIP-30 pack a custom emoji came from, for the "from <pack>"
 * line and its Add button.
 *
 * Checks the user's own resolved palette first (which already carries pack
 * provenance and covers the community palette), then the local pack index.
 * When both miss and an `authorPubkey` is supplied — the person who typed the
 * message or left the reaction — it falls back to an on-demand, author-scoped
 * relay lookup ({@link resolveEmojiSourceFromAuthor}): their NIP-65 write
 * relays → their kind-10030 → the referenced packs. This runs only when a
 * popover is actually open (the hook lives in that popover's body), so it is a
 * per-click cost, never a fan-out on render.
 *
 * `source` is undefined for native emoji and for custom emoji whose pack cannot
 * be resolved from any of those sources. `isLoading` is true only while the
 * author-scoped relay lookup is actually in flight — a local hit never sets it,
 * and it lets the popover show a skeleton instead of an empty footer during the
 * multi-round-trip fetch.
 */
export interface EmojiSourceResult {
  source: EmojiSource | undefined;
  /** The on-demand author-scoped relay lookup is in flight. */
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

  // Only after the local index has settled and still missed — otherwise a cold
  // index (undefined on first render) would fire the network for an emoji we
  // already hold.
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

  // "Loading" is the WHOLE resolution effort with no answer yet, not just the
  // remote fetch. Three traps this has to cover, each of which showed as an
  // empty footer that later popped in:
  //   - the shared `usePackIndex` is still building (`indexPending`), so the
  //     remote query hasn't even been ENABLED yet;
  //   - the remote query is enabled but hasn't settled its first fetch
  //     (`!isFetched`) — react-query reports `isFetching` false for the render
  //     on which `enabled` flips true, before the fetch is scheduled;
  //   - a reopen holds a cached `null` and refetches in the BACKGROUND
  //     (`isFetching`, but `isPending`/`isLoading` false).
  // Once the remote query settles with no pack, all three are false and the
  // footer collapses to nothing rather than a forever-skeleton.
  const wantsRemote = !!url && !!authorPubkey && !local;
  const isLoading =
    !source && wantsRemote && (indexPending || isFetching || (remoteEnabled && !isFetched));
  return { source, isLoading };
}

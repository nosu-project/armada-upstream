import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { MutedPubkeysContext, type MutedPubkeysResult } from "@/contexts/MutedPubkeysContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { toast } from "@/hooks/useToast";
import { readFolded, writeFolded } from "@/lib/foldedCache";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";

/**
 * NIP-51 mute list kind. A user's muted pubkeys, hashtags, words, and threads.
 * Items may be public (`tags`) and/or private (NIP-44 encrypted to self in
 * `.content` as a stringified tag array).
 *
 * Armada reads this list on every surface that renders another person — chat
 * timelines, member lists, reactions, notifications, search, profiles — and
 * appends to it from the mute action in each of those menus. New mutes are
 * always written to the private/encrypted portion, so the list of people you
 * chose not to see isn't itself public.
 */
export const KIND_MUTE_LIST = 10000;

/**
 * Decode-once cache for the kind-10000 private-items decrypt, keyed by event id.
 * The mute list is read by several surfaces (DM list, future block checks);
 * decrypting the same immutable event on a remote/extension signer costs a
 * round-trip each time, so a single in-flight decrypt is shared per event id
 * (mirrors the kind-10009 memo in useUserGroupList).
 */
const muteListDecryptMemo = new Map<string, Promise<Set<string>>>();

/** Collect the pubkeys from a tag array's `p` tags into `out`. */
function collectMutedPubkeys(tags: string[][], out: Set<string>): void {
  for (const [name, value] of tags) {
    if (name === "p" && value) out.add(value);
  }
}

/**
 * Read every muted pubkey from a kind-10000 event: the public `p` tags plus the
 * NIP-44-decrypted private `p` tags in `.content`. Falls back to public-only
 * when there is no NIP-44 signer or decryption fails. Memoized by event id so
 * concurrent callers share one signer round-trip.
 */
async function readMutedPubkeys(
  event: NostrEvent | null,
  signer: NUser["signer"] | undefined,
): Promise<Set<string>> {
  if (!event) return new Set();

  const publicPubkeys = new Set<string>();
  collectMutedPubkeys(event.tags, publicPubkeys);

  // No encrypted content, or no signer to read it → public tags only.
  if (!event.content || !signer?.nip44) return publicPubkeys;

  const cached = muteListDecryptMemo.get(event.id);
  if (cached) return cached;

  const nip44 = signer.nip44;
  const work = (async (): Promise<Set<string>> => {
    const result = new Set(publicPubkeys);
    try {
      const decrypted = await nip44.decrypt(event.pubkey, event.content);
      const privateTags = JSON.parse(decrypted);
      if (Array.isArray(privateTags)) {
        collectMutedPubkeys(
          privateTags.filter((t): t is string[] => Array.isArray(t)),
          result,
        );
      }
    } catch (err) {
      console.warn("Failed to decrypt mute list private items:", err);
      muteListDecryptMemo.delete(event.id); // don't memoize a transient failure
    }
    return result;
  })();
  muteListDecryptMemo.set(event.id, work);
  return work;
}

/** Folded-cache key for the locally-persisted muted-pubkey list. */
function muteFoldKey(pubkey: string): string {
  return `mute-pubkeys:${pubkey}`;
}

/**
 * Shared read of the persisted muted-pubkey seed, one promise per pubkey.
 *
 * `useMutedPubkeys` is called by nearly every component that renders another
 * person — every message row, every member row, every reaction pill. The
 * network read is deduplicated by React Query, but the local seed read is a
 * plain effect, so without this each of those mounts would open its own
 * ArmadaDB round-trip for the same key on every render pass. Kept in step by
 * the mutations below rather than invalidated, since they know the exact list
 * they just wrote.
 */
const muteSeedMemo = new Map<string, Promise<string[]>>();

function readMuteSeed(pubkey: string): Promise<string[]> {
  const cached = muteSeedMemo.get(pubkey);
  if (cached) return cached;
  const work = readFolded<string[]>(muteFoldKey(pubkey))
    .then((stored) => stored ?? [])
    .catch(() => {
      muteSeedMemo.delete(pubkey); // a transient read failure shouldn't stick
      return [];
    });
  muteSeedMemo.set(pubkey, work);
  return work;
}

/** Persist a freshly-written list and keep the shared seed in step with it. */
async function persistMuteList(pubkey: string, pubkeys: string[]): Promise<void> {
  muteSeedMemo.set(pubkey, Promise.resolve([...pubkeys]));
  await writeFolded(muteFoldKey(pubkey), pubkeys).catch(() => undefined);
}

/**
 * Resolve the current user's muted pubkeys (NIP-51 kind 10000), combining
 * public and NIP-44-private `p` tags.
 *
 * Called ONCE, by `MutedPubkeysProvider` — every consumer reads the result
 * through {@link useMutedPubkeys}. To avoid a flash of muted content appearing
 * and then disappearing, the resolved list is persisted locally (folded cache)
 * and seeded on the next mount; the returned `ready` flag lets a consumer hold
 * rendering until the set is authoritative on a true cold start (no cache +
 * network in flight). This mirrors the plaintext-first pattern used for the
 * kind-10009 group list.
 */
export function useMutedPubkeysSource(): MutedPubkeysResult {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const relayKey = config.appRelays.join(",");
  const queryKey = useMemo(
    () => ["mute-list", user?.pubkey, relayKey],
    [user?.pubkey, relayKey],
  );

  // Locally-cached muted pubkeys, read once on mount so a returning user has the
  // set before the conversation list paints. `null` = not loaded yet, `[]` = no
  // cache existed (distinguishes "still reading the cache" from "cache empty").
  const [cachedPubkeys, setCachedPubkeys] = useState<string[] | null>(null);
  useEffect(() => {
    if (!user?.pubkey) {
      setCachedPubkeys(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const stored = await readMuteSeed(user.pubkey);
      if (cancelled) return;
      setCachedPubkeys(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.pubkey]);

  const query = useQuery<string[]>({
    queryKey,
    enabled: !!user?.pubkey,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;
      const events = await nostr.group(config.appRelays).query(
        [{ kinds: [KIND_MUTE_LIST], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) },
      );
      const event = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const pubkeys = [...(await readMutedPubkeys(event, user!.signer))];
      // Persist for an instant, flash-free seed next mount.
      void persistMuteList(pubkey, pubkeys);
      return pubkeys;
    },
  });

  // Network result is authoritative; otherwise fall back to the cached seed.
  const mutedPubkeys = useMemo(
    () => new Set(query.data ?? cachedPubkeys ?? []),
    [query.data, cachedPubkeys],
  );

  // Ready once we have a network result OR the local cache read finished (even
  // if it was empty). Not ready only on a true cold start with the network
  // still in flight — when there is genuinely nothing to filter with yet.
  const ready = !user?.pubkey || query.data !== undefined || cachedPubkeys !== null;

  // Keep the query cache reusable across re-mounts without a refetch flash.
  useEffect(() => {
    if (query.data) queryClient.setQueryData(queryKey, query.data);
  }, [query.data, queryClient, queryKey]);

  return useMemo(() => ({ mutedPubkeys, ready }), [mutedPubkeys, ready]);
}

/**
 * The current user's muted pubkeys — the single source of truth for "should
 * this person be rendered at all", read by every timeline, roster, tally,
 * notifier and search surface in the app.
 *
 * A context read, so adding the check to a new surface costs nothing and works
 * in a component tree that has no relay pool (see `MutedPubkeysContext` for
 * why the default is "nobody is muted").
 */
export function useMutedPubkeys(): MutedPubkeysResult {
  return useContext(MutedPubkeysContext);
}

/**
 * Read a kind-10000 event's public tags and its NIP-44-decrypted private tags
 * separately, preserving every item (not just `p` tags). Used when editing the
 * mute list so we keep existing public/private hashtags, words, threads, and
 * people intact. Returns empty arrays for a missing event or when the private
 * content can't be decrypted (so the caller never destroys items it couldn't
 * read).
 */
async function readMuteTags(
  event: NostrEvent | null,
  signer: NUser["signer"] | undefined,
): Promise<{ publicTags: string[][]; privateTags: string[][]; privateReadable: boolean }> {
  const publicTags = event ? event.tags.map((t) => [...t]) : [];
  if (!event?.content || !signer?.nip44) {
    // No private content to merge (or no signer to read it). Treat the private
    // portion as readable-but-empty so a fresh mute starts a private list.
    return { publicTags, privateTags: [], privateReadable: true };
  }
  try {
    const decrypted = await signer.nip44.decrypt(event.pubkey, event.content);
    const parsed = JSON.parse(decrypted);
    const privateTags = Array.isArray(parsed)
      ? parsed.filter((t): t is string[] => Array.isArray(t)).map((t) => [...t])
      : [];
    return { publicTags, privateTags, privateReadable: true };
  } catch (err) {
    console.warn("Failed to decrypt mute list private items:", err);
    // Can't read the private portion — signal that so we don't clobber it.
    return { publicTags, privateTags: [], privateReadable: false };
  }
}

/**
 * All kind-10000 writes run one at a time, process-wide.
 *
 * Every write is a read-modify-write spanning a network read, a signer
 * round-trip and a publish. Now that mute is offered from every message row,
 * member row and profile card, firing several in a row is ordinary use — and
 * fired concurrently they all read the SAME pre-edit list, each add only their
 * own pubkey, and the last publish to land overwrites the rest. Serializing
 * makes each write observe the previous one's result (mirrors the kind-10009
 * chain in useUserGroupList).
 */
let muteListWriteChain: Promise<unknown> = Promise.resolve();

function serializeMuteListWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = muteListWriteChain.then(write, write);
  // Swallow the result on the chain itself so one failed write neither wedges
  // the queue nor surfaces as an unhandled rejection; the caller still gets it.
  muteListWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * The created_at for the next version of a replaceable event.
 *
 * Replaceable events are ordered at SECOND granularity, and NIP-01 breaks a
 * created_at tie by lowest event id — so two writes within the same second
 * resolve arbitrarily and the later edit can lose to the earlier one. Muting
 * two people in consecutive clicks lands well inside one second, so force
 * strict monotonicity instead of trusting the wall clock.
 */
function nextCreatedAt(prev: NostrEvent | null): number {
  const now = Math.floor(Date.now() / 1000);
  return prev ? Math.max(now, prev.created_at + 1) : now;
}

interface MuteEditContext {
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>;
  nostr: ReturnType<typeof useNostr>["nostr"];
  relays: string[];
  publish: ReturnType<typeof useNostrPublish>["mutateAsync"];
}

/**
 * Read-modify-write one pubkey into or out of the mute list.
 *
 * `edit` receives the existing public and private items and returns the next
 * private items (public items are passed through as-is, minus whatever `edit`
 * removes from them) — or `null` to skip the publish entirely because there is
 * nothing to change.
 */
async function editMuteList(
  ctx: MuteEditContext,
  edit: (tags: { publicTags: string[][]; privateTags: string[][] }) =>
    | { publicTags: string[][]; privateTags: string[][] }
    | null,
): Promise<string[] | null> {
  const { user, nostr, relays, publish } = ctx;

  // Read the freshest list from the network so we edit rather than overwrite.
  const events = await nostr.group(relays).query(
    [{ kinds: [KIND_MUTE_LIST], authors: [user.pubkey], limit: 1 }],
    { signal: AbortSignal.timeout(6000) },
  );
  const prev = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;

  // An empty read is indistinguishable from a failed one (cold pool, AUTH,
  // wrong relay set). If this device has seen a non-empty mute list before,
  // refuse to rebuild from nothing — publishing would replace the user's
  // real list everywhere (kind 10000 is a replaceable event).
  if (!prev) {
    // Read the persisted list directly rather than through `readMuteSeed`: the
    // memo is a first-paint seed that another tab's write can leave stale, and
    // this is the check that decides whether we are allowed to publish at all.
    const cached = await readFolded<string[]>(muteFoldKey(user.pubkey));
    if (cached && cached.length > 0) {
      throw new Error("Couldn't load your existing mute list — not saving to avoid losing it.");
    }
  }

  const { publicTags, privateTags, privateReadable } = await readMuteTags(prev, user.signer);
  if (!privateReadable) {
    throw new Error("Couldn't read your existing mute list — not saving to avoid losing it.");
  }

  const next = edit({ publicTags, privateTags });
  if (!next) return null; // already in the requested state

  // Private items stay private, and new ones start private. Only encrypt an
  // empty private list when the previous event had one, so unmuting the last
  // private entry doesn't leave a stray ciphertext on a list that never had one.
  let content = "";
  if (next.privateTags.length > 0 || prev?.content) {
    if (!user.signer.nip44) {
      throw new Error("Your signer can't encrypt the mute list (NIP-44 required).");
    }
    content = await user.signer.nip44.encrypt(
      user.pubkey,
      JSON.stringify(next.privateTags),
    );
  }

  await publish({
    kind: KIND_MUTE_LIST,
    content,
    tags: next.publicTags,
    created_at: nextCreatedAt(prev),
    prev: prev ?? undefined,
  });

  const muted = new Set<string>();
  collectMutedPubkeys([...next.publicTags, ...next.privateTags], muted);
  return [...muted];
}

/**
 * Mute a pubkey by appending it to the user's NIP-51 mute list (kind 10000).
 *
 * The new entry is written to the *private* (NIP-44-encrypted) portion of the
 * list, preserving any existing public and private items. Requires a NIP-44
 * capable signer. On success the mute-list query cache and the local folded
 * cache are updated so the person disappears from every surface immediately.
 */
export function useMuteUser(): UseMutationResult<void, Error, string> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();
  const relayKey = config.appRelays.join(",");
  const queryKey = ["mute-list", user?.pubkey, relayKey] as const;

  return useMutation({
    onMutate: async (pubkey: string) => {
      if (!user) return;

      // Stop an in-flight read from replacing the optimistic mute with the
      // relay's pre-publish list, then hide the peer before any network or
      // signer round-trips begin.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<string[]>(queryKey);
      queryClient.setQueryData<string[]>(queryKey, (current = []) =>
        current.includes(pubkey) ? current : [...current, pubkey],
      );
      return { previous };
    },
    mutationFn: (pubkey: string) => serializeMuteListWrite(async () => {
      if (!user) throw new Error("You must be logged in to mute someone.");
      if (!user.signer.nip44) {
        throw new Error("Your signer can't encrypt the mute list (NIP-44 required).");
      }

      const next = await editMuteList(
        { user, nostr, relays: config.appRelays, publish: publish.mutateAsync },
        ({ publicTags, privateTags }) => {
          const alreadyMuted = [...publicTags, ...privateTags].some(
            ([name, value]) => name === "p" && value === pubkey,
          );
          if (alreadyMuted) return null;
          return { publicTags, privateTags: [...privateTags, ["p", pubkey]] };
        },
      );

      // Replace the optimistic entry with the complete list we just published
      // and persist it for the next cold start. Do not immediately refetch: a
      // relay may still echo the superseded replaceable event and undo the
      // successful mute in the UI.
      if (next) {
        queryClient.setQueryData(queryKey, next);
        await persistMuteList(user.pubkey, next);
      }
    }),
    onError: (_error, _pubkey, context) => {
      if (!user) return;
      if (context?.previous === undefined) {
        queryClient.removeQueries({ queryKey, exact: true });
      } else {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
  });
}

/**
 * Unmute a pubkey by removing it from the user's NIP-51 mute list (kind 10000).
 *
 * Removes the `p` tag from whichever portion holds it — a mute published
 * publicly by another client is removed from the public tags, ours from the
 * encrypted content — while every other item, of every type, is preserved. The
 * same read-modify-write refusals as {@link useMuteUser} apply: a failed read
 * must never become a published empty list.
 */
export function useUnmuteUser(): UseMutationResult<void, Error, string> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const publish = useNostrPublish();
  const relayKey = config.appRelays.join(",");
  const queryKey = ["mute-list", user?.pubkey, relayKey] as const;

  return useMutation({
    onMutate: async (pubkey: string) => {
      if (!user) return;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<string[]>(queryKey);
      queryClient.setQueryData<string[]>(queryKey, (current = []) =>
        current.filter((p) => p !== pubkey),
      );
      return { previous };
    },
    mutationFn: (pubkey: string) => serializeMuteListWrite(async () => {
      if (!user) throw new Error("You must be logged in to unmute someone.");

      const isTarget = ([name, value]: string[]) => name === "p" && value === pubkey;
      const next = await editMuteList(
        { user, nostr, relays: config.appRelays, publish: publish.mutateAsync },
        ({ publicTags, privateTags }) => {
          if (![...publicTags, ...privateTags].some(isTarget)) return null;
          return {
            publicTags: publicTags.filter((t) => !isTarget(t)),
            privateTags: privateTags.filter((t) => !isTarget(t)),
          };
        },
      );

      if (next) {
        queryClient.setQueryData(queryKey, next);
        await persistMuteList(user.pubkey, next);
      }
    }),
    onError: (_error, _pubkey, context) => {
      if (!user) return;
      if (context?.previous === undefined) {
        queryClient.removeQueries({ queryKey, exact: true });
      } else {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
  });
}

export interface MuteToggle {
  /** Whether this pubkey is currently muted. */
  muted: boolean;
  /**
   * Whether a mute action should be offered at all: there is a logged-in user,
   * a target, and the target isn't the user themselves.
   */
  canMute: boolean;
  /** A write is in flight; the menu item should be disabled. */
  pending: boolean;
  /** "Mute" or "Unmute", for the menu label. */
  label: string;
  /** Toggle the mute, reporting the outcome with a toast. Never throws. */
  toggle: () => Promise<void>;
}

/**
 * Everything a menu needs to offer mute/unmute for one person, so that adding
 * the action to a new surface is a label and an `onSelect` rather than another
 * copy of the mutation wiring, the self-check and the error toast. Used by the
 * message action menus, the member list, the profile cards and the DM header.
 */
export function useMuteToggle(pubkey: string | undefined): MuteToggle {
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const muteUser = useMuteUser();
  const unmuteUser = useUnmuteUser();

  const muted = !!pubkey && mutedPubkeys.has(pubkey);
  const canMute = !!pubkey && !!user && pubkey !== user.pubkey;
  const pending = muteUser.isPending || unmuteUser.isPending;

  const toggle = useCallback(async () => {
    if (!pubkey || !canMute) return;
    try {
      if (muted) {
        await unmuteUser.mutateAsync(pubkey);
        toast({ title: "Unmuted", description: "You'll see this person again." });
      } else {
        await muteUser.mutateAsync(pubkey);
        toast({ title: "Muted", description: "You won't see this person anymore." });
      }
    } catch (e) {
      toast({
        title: muted ? "Couldn't unmute" : "Couldn't mute",
        description: e instanceof Error ? e.message : "Failed to update your mute list.",
        variant: "destructive",
      });
    }
  }, [pubkey, canMute, muted, muteUser, unmuteUser]);

  return { muted, canMute, pending, label: muted ? "Unmute" : "Mute", toggle };
}

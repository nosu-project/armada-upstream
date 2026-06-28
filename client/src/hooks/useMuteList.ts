import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { readFolded, writeFolded } from "@/lib/concord/foldedCache";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";

/**
 * NIP-51 mute list kind. A user's muted pubkeys, hashtags, words, and threads.
 * Items may be public (`tags`) and/or private (NIP-44 encrypted to self in
 * `.content` as a stringified tag array). We only read it here — to hide muted
 * people from the DM conversation list — so this hook is intentionally
 * read-only. Mutating the mute list lives wherever the "block user" action is.
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

export interface MutedPubkeysResult {
  /** The set of pubkeys the user has muted. */
  mutedPubkeys: Set<string>;
  /**
   * Whether the mute set is settled enough to filter on. False only during the
   * very first cold load (no locally-cached list and the network query still in
   * flight). Once a previously-cached list is read, or the network query
   * resolves, this is true — so consumers can wait to render until muted
   * conversations are already excluded, instead of showing them then hiding
   * them.
   */
  ready: boolean;
}

/**
 * The current user's muted pubkeys (NIP-51 kind 10000), combining public and
 * NIP-44-private `p` tags. Used to hide muted people from the DM conversation
 * list.
 *
 * To avoid a flash of muted conversations appearing and then disappearing, the
 * resolved list is persisted locally (folded cache) and seeded synchronously on
 * the next mount; the returned `ready` flag lets a consumer hold rendering
 * until the set is authoritative on a true cold start (no cache + network in
 * flight). This mirrors the plaintext-first pattern used for the kind-10009
 * group list.
 */
export function useMutedPubkeys(): MutedPubkeysResult {
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
      const stored = await readFolded<string[]>(muteFoldKey(user.pubkey));
      if (cancelled) return;
      setCachedPubkeys(stored ?? []);
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
      void writeFolded(muteFoldKey(pubkey), pubkeys);
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

  return { mutedPubkeys, ready };
}

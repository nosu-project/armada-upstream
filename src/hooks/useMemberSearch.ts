import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useServerScope } from "@/contexts/ServerScopeContext";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";

import type { QueryClient } from "@tanstack/react-query";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { ServerProfile } from "@/lib/nip29";

type AuthorEntry = { event?: NostrEvent; metadata?: NostrMetadata } | undefined;

/**
 * Re-render whenever a profile the roster is matching against lands in the
 * cache, so results fill in as names resolve instead of freezing at whatever
 * was cached on the keystroke. Inert while no search is active — a roster that
 * isn't being filtered doesn't subscribe at all.
 */
function useProfileCacheVersion(active: boolean): number {
  const queryClient = useQueryClient();
  const version = useRef(0);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!active) return () => {};
      return queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        const key = event.query.queryKey[0];
        if (key !== "author" && key !== "server-profile") return;
        version.current += 1;
        onChange();
      });
    },
    [active, queryClient],
  );

  return useSyncExternalStore(subscribe, () => version.current);
}

/**
 * The text a member can be found by: their per-server nickname (what the row
 * actually renders in a server scope) plus their global profile fields. Read
 * straight from the shared query cache rather than re-fetching — every row on
 * screen has already resolved these through `useAuthor`/`useServerProfile`.
 */
function searchableText(
  queryClient: QueryClient,
  relayUrl: string | undefined,
  pubkey: string,
): string {
  const author = queryClient.getQueryData<AuthorEntry>(["author", pubkey]);
  const metadata = author?.metadata;
  const scoped = relayUrl
    ? queryClient.getQueryData<ServerProfile | null>(["server-profile", relayUrl, pubkey])
    : undefined;

  return [
    scoped?.nickname,
    scoped?.label,
    metadata?.name,
    metadata?.display_name,
    metadata?.nip05,
    // The fallback the row shows when there's no kind 0 at all.
    getDisplayName(metadata, pubkey),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Filter a roster by a free-text query.
 *
 * Names match on tokens — every whitespace-separated word must appear
 * somewhere in the member's searchable text, so word order and which field a
 * word came from don't matter (matching `profileMatches` in
 * {@link useSearchProfiles}). A query that looks like a key instead matches on
 * an npub or hex *prefix*, so pasting an npub finds exactly one person while a
 * short name query isn't swallowed by every pubkey containing that letter.
 *
 * Returns `null` when no search is active, which callers should read as "show
 * everything" — distinct from an empty set, which means "nothing matched".
 */
export function useMemberSearch(pubkeys: string[], query: string): Set<string> | null {
  const queryClient = useQueryClient();
  const relayUrl = useServerScope();

  // A leading @ is how people type a name; it's never part of one.
  const normalized = query.trim().replace(/^@+/, "").toLowerCase();
  const active = normalized.length > 0;
  const version = useProfileCacheVersion(active);

  // `pubkeys` is a fresh array most renders, so key the memo on its identity
  // rather than the array itself.
  const rosterKey = pubkeys.join(",");

  return useMemo(() => {
    if (!active) return null;

    const tokens = normalized.split(/\s+/).filter(Boolean);
    const byKey = normalized.startsWith("npub1") || /^[0-9a-f]{8,}$/.test(normalized);

    const matched = new Set<string>();
    for (const pubkey of pubkeys) {
      if (byKey) {
        const npub = normalized.startsWith("npub1") ? tryNpubEncode(pubkey) : undefined;
        if (pubkey.startsWith(normalized) || npub?.startsWith(normalized)) matched.add(pubkey);
        continue;
      }
      const haystack = searchableText(queryClient, relayUrl, pubkey);
      if (tokens.every((token) => haystack.includes(token))) matched.add(pubkey);
    }
    return matched;
    // `version` is a cache-revision tripwire: it carries no value of its own,
    // it just re-runs the match when a name it depends on has arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, normalized, rosterKey, relayUrl, queryClient, version]);
}

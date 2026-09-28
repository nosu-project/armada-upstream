import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useServerScope } from "@/contexts/ServerScopeContext";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";

import type { QueryClient } from "@tanstack/react-query";
import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";
import type { ServerProfile } from "@/lib/nip29";

type AuthorEntry = { event?: NostrEvent; metadata?: NostrMetadata } | undefined;

/** Re-render as matched profiles land in the cache; inert while no search is active. */
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

/** Per-server nickname plus global profile fields, read from the shared query cache. */
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
    getDisplayName(metadata, pubkey),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Token match on names (every word anywhere, like `profileMatches` in
 * {@link useSearchProfiles}); key-like queries match an npub/hex *prefix*.
 * Returns `null` when no search is active ("show everything"), distinct from an empty set.
 */
export function useMemberSearch(pubkeys: string[], query: string): Set<string> | null {
  const queryClient = useQueryClient();
  const relayUrl = useServerScope();

  const normalized = query.trim().replace(/^@+/, "").toLowerCase();
  const active = normalized.length > 0;
  const version = useProfileCacheVersion(active);

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
    // `version` is a cache-revision tripwire that re-runs the match as names arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, normalized, rosterKey, relayUrl, queryClient, version]);
}

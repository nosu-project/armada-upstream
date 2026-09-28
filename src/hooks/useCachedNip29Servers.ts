import { useEffect, useState } from "react";

import { onFoldedWrite } from "@/lib/foldedCache";
import { groupListFoldKey, readCachedGroupList } from "@/lib/nip29ServerCache";

const EMPTY: string[] = [];

/**
 * The user's NIP-29 servers from the folded 10009 snapshot, for `NostrProvider`
 * only (it can't use `useUserGroupList`, which depends on it). `onFoldedWrite`
 * re-reads on each new snapshot. Everyone else: `useUserGroupList()`.
 */
export function useCachedNip29Servers(pubkey: string | undefined): string[] {
  const [servers, setServers] = useState<string[]>(EMPTY);

  useEffect(() => {
    if (!pubkey) {
      setServers(EMPTY);
      return;
    }
    let cancelled = false;
    const key = groupListFoldKey(pubkey);

    const load = () => {
      void readCachedGroupList(pubkey).then((cached) => {
        if (cancelled) return;
        const next = cached?.servers ?? EMPTY;
        // Replace, never merge, so removals shrink the set.
        setServers((prev) =>
          prev.length === next.length && prev.every((url, i) => url === next[i]) ? prev : next,
        );
      });
    };

    load();
    const unsubscribe = onFoldedWrite((written) => {
      if (written === key) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [pubkey]);

  return servers;
}

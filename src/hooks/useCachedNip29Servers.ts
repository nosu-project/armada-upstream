import { useEffect, useState } from "react";

import { onFoldedWrite } from "@/lib/foldedCache";
import { groupListFoldKey, readCachedGroupList } from "@/lib/nip29ServerCache";

const EMPTY: string[] = [];

/**
 * The user's NIP-29 servers read straight from the folded 10009 snapshot.
 *
 * Every other consumer should use `useUserGroupList()`, which also refreshes
 * from the network. This hook exists for the one place that CAN'T:
 * `NostrProvider` provides the Nostrify context that `useUserGroupList`
 * depends on, so it must source its pool routes without it. Reading the fold
 * needs neither a relay nor a signer, and `onFoldedWrite` re-reads it the
 * moment the list query or a list mutation persists a new snapshot — so
 * adding or removing a server updates the pool without a reload.
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
        // Replace, never merge: the snapshot is the whole truth, so a removal
        // has to be able to shrink this set.
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

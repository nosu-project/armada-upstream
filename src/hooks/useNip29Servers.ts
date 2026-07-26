import { useMemo } from "react";

import { useUserGroupList } from "@/hooks/useUserGroupList";
import { normalizeRelayUrl, PINNED_RAIL_RELAYS } from "@/lib/platform";

/**
 * The user's NIP-29 servers as stable rail keys: any opt-in build-time pinned
 * relays followed by the servers in their kind 10009 list, normalized and
 * de-duplicated, first occurrence winning.
 *
 * This is THE source for "which NIP-29 communities exist" — the rail, the
 * quick switcher and the landing redirect all read it, so they can't drift.
 * There is no local mirror to fall out of sync with: removing a server from
 * the 10009 list removes it here, everywhere, at once.
 */
export function useNip29Servers(): string[] {
  const { data: groupList } = useUserGroupList();
  const listServers = groupList?.servers;

  return useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const url of [...PINNED_RAIL_RELAYS, ...(listServers ?? [])]) {
      const normalized = normalizeRelayUrl(url);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
    return out;
  }, [listServers]);
}

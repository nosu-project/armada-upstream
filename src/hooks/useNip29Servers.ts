import { useMemo } from "react";

import { useUserGroupList } from "@/hooks/useUserGroupList";
import { normalizeRelayUrl } from "@/lib/platform";

/**
 * THE source for "which NIP-29 communities exist" (rail, switcher, landing): the kind 10009
 * servers, normalized and deduped.
 */
export function useNip29Servers(): string[] {
  const { data: groupList } = useUserGroupList();
  const listServers = groupList?.servers;

  return useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const url of listServers ?? []) {
      const normalized = normalizeRelayUrl(url);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    }
    return out;
  }, [listServers]);
}

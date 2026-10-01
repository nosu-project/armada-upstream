import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";

import { EventStoreContext } from "@/contexts/EventStoreContext";
import { KIND_GROUP_METADATA, parseGroupMetadata } from "@/lib/nip29";

/**
 * A group's kind-39000 from its relay's local tenant (see `relayScope.ts`), so a
 * pasted link opens no socket. Nullable context: degrades without providers.
 */
export function useLocalGroupMeta(relayUrl: string, groupId: string | undefined) {
  const storePromise = useContext(EventStoreContext);
  const { data } = useQuery({
    queryKey: ["self-link-nip29-meta", relayUrl, groupId ?? ""],
    enabled: !!storePromise && !!groupId,
    queryFn: async ({ signal }) => {
      const store = await storePromise!;
      const events = await store.query(
        [{ kinds: [KIND_GROUP_METADATA], "#d": [groupId!], limit: 1 }],
        { relay: relayUrl, signal },
      );
      return events[0] ? parseGroupMetadata(events[0], relayUrl) : null;
    },
    staleTime: 5 * 60 * 1000,
  });
  return data ?? undefined;
}

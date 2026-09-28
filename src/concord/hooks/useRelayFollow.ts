import { useEffect, useRef } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { capRelays, type Community } from "@/concord/lib/types";
import { logSync } from "@/lib/syncLog";

/**
 * Follow the fold's relay list (CORD-02 §6). The Community List's
 * `current.relays` is a join-time snapshot; the fold is the authority, so a
 * differing folded relay set is written back into the list entry (which also
 * moves the member's other devices, via the synced 33302 List).
 */
export function useRelayFollow(community: Community | undefined): void {
  const { data: folded } = useControlFold(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const entry = useCommunityEntry(community?.idHex);
  // Guards only the IN-FLIGHT write; once it lands the list's optimistic cache
  // gates via equality, so a later flip back to a seen set is still followed.
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!community || !entry || !folded?.metadata) return;
    // Compare what members honor (capRelays). An empty folded set is "no
    // instruction", never a disconnect (§6).
    const foldRelays = capRelays(Array.isArray(folded.metadata.relays) ? folded.metadata.relays : []);
    if (foldRelays.length === 0) return;
    const listRelays = Array.isArray(entry.current.relays) ? entry.current.relays : [];
    if (foldRelays.length === listRelays.length && foldRelays.every((r, i) => r === listRelays[i])) return;

    const key = `${community.idHex}|${foldRelays.join(",")}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);

    logSync(
      "relays",
      `${community.idHex.slice(0, 8)} fold moved relays: [${listRelays.join(", ")}] → [${foldRelays.join(", ")}]`,
    );
    updateList({ type: "refresh-relays", communityId: community.idHex, relays: foldRelays })
      .catch(() => undefined) // a failed publish re-arms below; the next fold pass retries
      .finally(() => {
        handled.current.delete(key);
      });
  }, [community, entry, folded, updateList]);
}

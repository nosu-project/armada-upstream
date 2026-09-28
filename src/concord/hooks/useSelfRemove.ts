import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { removeCommunityLocally, useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { banlistLocator, bytesToHex } from "@/concord/lib/derive";
import { forgetPendingJoin } from "@/concord/lib/pendingJoins";
import { selfRemovalVerdict, type SelfRemovalVerdict } from "@/concord/lib/selfRemoval";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRemoveRailKey } from "@/hooks/useRemoveRailKey";
import { toast } from "@/hooks/useToast";
import { logSync } from "@/lib/syncLog";

/**
 * Compliant self-removal (CORD-04 §4/§6): a client that finds a removal against
 * its OWN npub tears down its local copy and routes away. Handles both a folded
 * Banlist entry (enforced by the following Refounding) and a Guestbook `kick`
 * (enforced by nothing — this compliance is a kick's whole effect on the target).
 *
 * Network-silent: the only write is the private Community List vault, so other
 * devices don't resurrect the entry. Narrower than rekey-exclusion on purpose:
 * a rotation can be a mistake; a kick or ban is a judgment.
 */
export function useSelfRemove(community: Community | undefined, onRemoved?: () => void): void {
  const { user } = useCurrentUser();
  const control = useControlFold(community);
  const folded = control.data;
  const guestbook = useGuestbook(community);
  const { coalesced } = guestbook;
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const entry = useCommunityEntry(community?.idHex);
  const queryClient = useQueryClient();
  const removeRailKey = useRemoveRailKey();
  const handled = useRef(new Set<string>());
  // Verdicts awaiting a confirming refetch, keyed by community AND verdict;
  // cleared when the verdict lifts.
  const confirming = useRef(new Set<string>());

  useEffect(() => {
    if (!community || !entry || !folded || !user) return;

    const key = community.idHex;
    // A removal only counts if it POSTDATES this membership (see `selfRemovalVerdict`).
    const banlistHead = folded.headEditions.get(bytesToHex(banlistLocator(community.id)));
    const mine = coalesced.get(user.pubkey);
    const verdict = selfRemovalVerdict({
      selfHex: user.pubkey,
      ownerHex: community.owner,
      addedAtMs: entry.added_at,
      banned: folded.banned.has(user.pubkey),
      banlistHeadAtSecs: banlistHead?.createdAt,
      guestbook: mine ? { state: mine.state, ms: mine.ms } : undefined,
    });
    if (!verdict) {
      confirming.current.delete(`${key}:ban`);
      confirming.current.delete(`${key}:kick`);
      return;
    }
    if (handled.current.has(key)) return;

    // Removal is costly, so require the verdict TWICE, a render apart: a returning
    // unbanned member or a rejoiner can see a stale verdict during propagation.
    // `refetch()` is a pure store read (the sweep runs in the background), so this
    // is a debounce, not a network re-confirmation.
    const plane = verdict === "ban" ? control : guestbook;
    if (!confirming.current.has(`${key}:${verdict}`)) {
      confirming.current.add(`${key}:${verdict}`);
      void plane.refetch();
      return;
    }
    if (plane.isLoading || plane.isFetching) return; // wait for the confirming fetch to settle

    handled.current.add(key);
    logSync("control", `${key.slice(0, 8)} ${verdict} names ME — silent self-removal`);
    // Tear the LOCAL view down now and run the vault write (a network RMW, for other
    // devices) in the background. Tombstone the rail entry immediately in the cache
    // AND the folded list on disk, as a Leave does, or a relaunch would restore it;
    // the vault write records the same `removedAt`.
    const removedAt = Date.now();
    removeCommunityLocally(queryClient, user.pubkey, community.idHex, removedAt).catch((e) => {
      logSync("list2", `${key.slice(0, 8)} self-removal: folded write failed (${e instanceof Error ? e.message : String(e)})`);
    });
    // Drop any pending join too, or the next launch would resume it.
    void forgetPendingJoin(user.pubkey, community.idHex);
    removeRailKey(`c2:${community.idHex}`);
    queryClient.removeQueries({ queryKey: ["concord", key] });
    toast(REMOVAL_TOAST[verdict]);
    onRemoved?.();
    updateList({ type: "remove", communityId: community.idHex, removedAt }).catch(() => {
      // Vault write failed: the local tombstone stands and the next sync republishes
      // it; clear `handled` so a still-resolving entry retries.
      handled.current.delete(key);
    });
    // Depend on the stable fields, not the per-render objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    community,
    entry,
    folded,
    coalesced,
    user,
    control.isLoading,
    control.isFetching,
    control.refetch,
    guestbook.isLoading,
    guestbook.isFetching,
    guestbook.refetch,
    updateList,
    queryClient,
    removeRailKey,
    onRemoved,
  ]);
}

/** A kick is re-joinable and a ban is not; the notice says which. */
const REMOVAL_TOAST: Record<SelfRemovalVerdict, { title: string; description: string }> = {
  ban: {
    title: "Removed from community",
    description: "You no longer have access to this community.",
  },
  kick: {
    title: "Removed from community",
    description: "A moderator removed you from this community. You can rejoin with a new invite.",
  },
};

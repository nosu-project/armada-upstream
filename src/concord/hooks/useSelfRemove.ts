import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useGuestbook } from "@/concord/hooks/useGuestbook";
import { listQueryKey, useCommunityEntry, useUpdateCommunityList, type ListData } from "@/concord/hooks/useCommunityList";
import { removeFromList } from "@/concord/lib/communityList";
import { banlistLocator, bytesToHex } from "@/concord/lib/derive";
import { selfRemovalVerdict, type SelfRemovalVerdict } from "@/concord/lib/selfRemoval";
import type { Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { logSync } from "@/lib/syncLog";

/**
 * Compliant self-removal (CORD-04 §4/§6): a client that finds a removal against
 * its OWN npub tears down its local copy and routes away.
 *
 * BOTH removals land here, because "removed from the community" is one local
 * state whatever minted it:
 *
 *   - the folded Control-plane Banlist naming me — enforced by the Refounding
 *     that follows it, so an ignoring client is merely rude to itself;
 *   - my coalesced Guestbook state being `kick` — enforced by NOTHING. The
 *     Guestbook is cooperative: the stream keys still open, so this compliance
 *     is the entire effect a kick has on the kicked member's own screen. Left
 *     unhandled, a kick removed the target from everyone's member list except
 *     the target's, who kept reading and writing as though nothing happened.
 *
 * Network-SILENT by design: no Leave directive, no farewell, nothing published
 * to the community (a ban's events are already dropped by every honest client,
 * and a kick is already recorded by the moderator's own directive). The only
 * write is the member's private Community List vault, so their other devices
 * don't resurrect the entry.
 *
 * Still deliberately narrower than rekey-exclusion: a rotation that carries no
 * blob for me but names me in neither plane keeps the read-only rail entry (the
 * stranded/excluded machinery) — a rotation can be a mistake; a kick or a ban is
 * a judgment.
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
  const handled = useRef(new Set<string>());
  // Verdicts we've seen once and forced a confirming refetch for; keyed by
  // community AND verdict, since the two are confirmed against different
  // planes. Cleared the moment the verdict lifts.
  const confirming = useRef(new Set<string>());

  useEffect(() => {
    if (!community || !entry || !folded || !user) return;

    const key = community.idHex;
    // A removal only counts if it POSTDATES this membership — see
    // `selfRemovalVerdict` for the two ways a stale one resurfaces.
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

    // Self-removal costs a re-invite (ban) or at least a fresh invite link
    // (kick), so a lone sighting is not enough: an unbanned member returning
    // through a relay that withholds the unban head — or a rejoiner whose own
    // Join hasn't come back around the Guestbook yet — would tear down during
    // the propagation gap. Force one fresh fetch of the plane that convicted
    // (the live stream keeps feeding the store) and act only on a verdict that
    // SURVIVES it.
    const plane = verdict === "ban" ? control : guestbook;
    if (!confirming.current.has(`${key}:${verdict}`)) {
      confirming.current.add(`${key}:${verdict}`);
      void plane.refetch();
      return;
    }
    if (plane.isLoading || plane.isFetching) return; // wait for the confirming fetch to settle

    handled.current.add(key);
    logSync("control", `${key.slice(0, 8)} ${verdict} names ME — silent self-removal`);
    // Tear the LOCAL view down immediately — remove the queries, notify, route
    // away — and let the vault write run in the BACKGROUND. The vault write is
    // durability for the user's OTHER devices ("so they don't resurrect the
    // entry"), not a precondition for this screen leaving the community, and it
    // is a full read-modify-write over the network: a fragment read that waits
    // on a (possibly NIP-42-gated) account-state relay plus a publish. Gating
    // the route-away on it left the kickee sitting in a room they'd already been
    // removed from for seconds after the kick had been decided locally.
    // Tombstone the rail entry NOW. The list query is otherwise only refreshed
    // by updateCommunityList's own setQueryData at the END of its network RMW,
    // so the community icon lingered in the rail for the RMW's duration after
    // the room had already been torn down. This optimistic removal mirrors the
    // same tombstone the vault write will record durably (removeFromList), and
    // the background write reconciles it against the relays.
    queryClient.setQueryData<ListData>(listQueryKey(user.pubkey), (prev) =>
      prev ? { ...prev, list: removeFromList(prev.list, community.idHex, Date.now()) } : prev,
    );
    queryClient.removeQueries({ queryKey: ["concord", key] });
    toast(REMOVAL_TOAST[verdict]);
    onRemoved?.();
    updateList({ type: "remove", communityId: community.idHex }).catch(() => {
      // The vault write failed (offline / no relay confirmed). The verdict is
      // still standing in the store, so clear `handled` and let the next mount
      // (a later visit, or app relaunch) re-derive it and retry the write.
      handled.current.delete(key);
    });
    // `control`/`guestbook` are fresh objects each render; depend on their
    // stable fields, not on them.
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

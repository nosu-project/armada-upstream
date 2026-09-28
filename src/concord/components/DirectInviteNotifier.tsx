import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { ToastAction } from "@/components/ui/toast";
import { assertNotDissolved, bundleToEntry, DissolvedCommunityError } from "@/concord/hooks/useCommunityActions";
import { useCommunity, useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useInviteInbox, type ParkedInvite } from "@/concord/hooks/useDirectInvites";
import { judgeCatchUp, type CatchUpVerdict } from "@/concord/lib/catchUpAdoption";
import { catchUpChannelIds, heldMembershipOf } from "@/concord/lib/directInvite";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";

/**
 * Passive notifier for direct Concord invites (CORD-05 §6): a toast pointing
 * to `/invites`, where joining is decided. Exception: a catch-up (a private
 * channel key for an existing community, vended by a role grant) that the
 * fold confirms (`judgeCatchUp`) is APPLIED here — the Grant was the consent.
 * Never fetches the sender's profile before the user decides.
 */
export function DirectInviteNotifier() {
  const { items } = useInviteInbox();
  const { pathname } = useLocation();
  // Session-scoped so polls don't re-toast; a relaunch nudges once more.
  const announced = useRef<Set<string>>(new Set());
  // Wait for each catch-up's verdict rather than toast a decision about to be made.
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, CatchUpVerdict>>(new Map());
  const onVerdict = useCallback((wrapId: string, verdict: CatchUpVerdict) => {
    setVerdicts((prev) => (prev.get(wrapId) === verdict ? prev : new Map(prev).set(wrapId, verdict)));
  }, []);
  const onAdopted = useCallback((wrapId: string) => {
    announced.current.add(wrapId);
  }, []);

  const onInbox = pathname === "/invites";

  useEffect(() => {
    if (onInbox) {
      for (const it of items) announced.current.add(it.invite.wrapId);
      return;
    }

    const fresh = items.filter((it) => {
      if (!it.unread || announced.current.has(it.invite.wrapId)) return false;
      if (!it.invite.catchUp) return true;
      // Catch-ups are offered only once judged not adoptable.
      const verdict = verdicts.get(it.invite.wrapId);
      return verdict === "banned" || verdict === "sender-not-staff" || verdict === "not-entitled";
    });
    if (fresh.length === 0) return;
    for (const it of fresh) announced.current.add(it.invite.wrapId);

    const newest = fresh[0].invite;
    const title =
      fresh.length > 1
        ? `${fresh.length} new community invites`
        : newest.catchUp
          ? "New channel keys offered"
          : "New community invite";

    toast({
      title,
      description: fresh.length > 1 ? undefined : newest.name,
      action: (
        <ToastAction altText="View invites" asChild>
          <Link to="/invites">View</Link>
        </ToastAction>
      ),
    });
  }, [items, onInbox, verdicts]);

  return (
    <>
      {items
        .filter((it) => it.invite.catchUp)
        .map((it) => (
          <CatchUpAdopter key={it.invite.wrapId} invite={it.invite} onVerdict={onVerdict} onAdopted={onAdopted} />
        ))}
    </>
  );
}

/** Judges one parked catch-up against its community's fold and applies it if confirmed. */
function CatchUpAdopter({
  invite,
  onVerdict,
  onAdopted,
}: {
  invite: ParkedInvite;
  onVerdict: (wrapId: string, verdict: CatchUpVerdict) => void;
  onAdopted: (wrapId: string) => void;
}) {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const entry = useCommunityEntry(invite.communityId);
  const community = useCommunity(invite.communityId);
  const { data: folded } = useControlFold(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();
  // The `add` merge is epoch-monotonic (CORD-02 §8), so a racing re-apply can't regress keys.
  const applied = useRef(false);

  const held = useMemo(() => (entry ? heldMembershipOf(entry) : undefined), [entry]);
  const verdict: CatchUpVerdict = useMemo(() => {
    // An unreadable membership list is not a verdict.
    if (!user || !held) return "no-fold";
    return judgeCatchUp(folded, user.pubkey, invite.sender, invite.bundle, held);
  }, [folded, user, invite, held]);

  useEffect(() => {
    onVerdict(invite.wrapId, verdict);
  }, [invite.wrapId, verdict, onVerdict]);

  useEffect(() => {
    if (verdict !== "adopt" || applied.current || !held) return;
    applied.current = true;
    const vended = new Set(catchUpChannelIds(held, invite.bundle));
    const names = invite.bundle.channels.filter((c) => vended.has(c.id.toLowerCase())).map((c) => c.name);
    void (async () => {
      try {
        // A dissolved community takes no new keys; the inbox's Accept explains why.
        await assertNotDissolved(nostr, invite.bundle);
        // Pinned to the held base (isCatchUpBundle), so it only contributes channel keys.
        await updateList({ type: "add", entry: bundleToEntry(invite.bundle) });
      } catch (e) {
        if (e instanceof DissolvedCommunityError) return;
        // Vault write failed; a later render or Accept retries.
        applied.current = false;
        return;
      }
      onAdopted(invite.wrapId);
      toast({
        title: names.length === 1 ? "Channel added" : `${names.length} channels added`,
        description: `${names.map((n) => `#${n}`).join(", ")} in ${invite.name}`,
      });
      queryClient.invalidateQueries({ queryKey: ["concord", "direct-invites"] });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    })();
  }, [verdict, held, invite, nostr, updateList, onAdopted, queryClient]);

  return null;
}

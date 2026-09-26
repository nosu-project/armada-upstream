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
 * Passive notifier for received direct (gift-wrapped) Concord invites
 * (CORD-05 §6). Replaces the blocking one-at-a-time modal: a received invite
 * no longer interrupts — it lands in the routed inbox (`/invites`) with a rail
 * badge, and a new arrival raises a single non-blocking toast pointing there.
 *
 * Nothing here decrypts or reacts on the network; it reads the same parked
 * inbox the rail and the page do. Consent to JOIN still happens only at the
 * explicit Accept on the inbox page — the toast is a pointer, not a decision.
 *
 * A CATCH-UP is the exception, and the reason this is mounted globally rather
 * than merely announcing: a key for a private channel in a community the
 * member already belongs to, vended when an admin granted them a role
 * (`handleToggleRole` → `sendDirectInvite`). The consent for that channel was
 * the Grant, so a catch-up the folded Control Plane confirms — staff sender,
 * recipient entitled by their own roles, not banned (`judgeCatchUp`) — is
 * APPLIED here, and the member is told the channel is theirs. Parking it
 * behind an Accept reproduced the failure the vend exists to prevent: role
 * granted, one toast, and a channel that never appeared. A catch-up the fold
 * does NOT confirm keeps the old behaviour — announced, and decided on the
 * inbox page, where the bundle's full contents are on screen.
 *
 * Mounted globally (MainLayout) so an invite arriving on any screen is
 * announced. The invariant that only the seal-verified sender and claimed name
 * ever surface before the user decides is kept: the toast names the community
 * (the bundle's own claim) and never fetches the sender's profile.
 */
export function DirectInviteNotifier() {
  const { items } = useInviteInbox();
  const { pathname } = useLocation();
  // Invites announced this session, so a slow 5-minute poll re-listing the same
  // parked set doesn't re-toast it. Session-scoped by design: a relaunch with
  // still-unseen invites is worth one fresh nudge.
  const announced = useRef<Set<string>>(new Set());
  // Each catch-up's adopter reports what it decided, so the announcement below
  // can wait for the verdict rather than toast a decision that is about to be
  // made for the user.
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, CatchUpVerdict>>(new Map());
  const onVerdict = useCallback((wrapId: string, verdict: CatchUpVerdict) => {
    setVerdicts((prev) => (prev.get(wrapId) === verdict ? prev : new Map(prev).set(wrapId, verdict)));
  }, []);
  const onAdopted = useCallback((wrapId: string) => {
    announced.current.add(wrapId);
  }, []);

  // Already looking at them — don't toast what the user is reading.
  const onInbox = pathname === "/invites";

  useEffect(() => {
    if (onInbox) {
      // Mark everything currently pending as announced so leaving the page
      // doesn't immediately toast the invites just seen.
      for (const it of items) announced.current.add(it.invite.wrapId);
      return;
    }

    const fresh = items.filter((it) => {
      if (!it.unread || announced.current.has(it.invite.wrapId)) return false;
      if (!it.invite.catchUp) return true;
      // A catch-up is announced as an OFFER only once judged not adoptable.
      // An adoptable one is applied and announced by its adopter; one still
      // waiting on the fold (or already reconciled) is neither, yet.
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

/**
 * One parked catch-up, judged against its community's folded Control Plane
 * and applied when the fold confirms it. A component rather than a loop so
 * each catch-up gets its own community's hooks; renders nothing.
 */
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
  // One application per wrap per mount. The `add` merge is deterministic and
  // epoch-monotonic (CORD-02 §8), so a remount racing the inbox re-read can at
  // worst re-apply the same keys, never regress them.
  const applied = useRef(false);

  const held = useMemo(() => (entry ? heldMembershipOf(entry) : undefined), [entry]);
  const verdict: CatchUpVerdict = useMemo(() => {
    // The membership list not being readable yet is the same wait as the fold
    // not having loaded: neither is a verdict.
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
        // The inbox's Accept refuses a dissolved community, and so does this:
        // a dead community takes no new keys. Not retried and not toasted —
        // the community already reads dissolved wherever it is shown, and the
        // invite stays in the inbox, whose Accept says why it can't be used.
        await assertNotDissolved(nostr, invite.bundle);
        // Same write the inbox's Accept makes: the merge is pinned to the base
        // already held (isCatchUpBundle), so the only thing it can contribute
        // for a known community is channel keys.
        await updateList({ type: "add", entry: bundleToEntry(invite.bundle) });
      } catch (e) {
        if (e instanceof DissolvedCommunityError) return;
        // The vault write never landed; a later render (or the inbox's own
        // Accept) retries.
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

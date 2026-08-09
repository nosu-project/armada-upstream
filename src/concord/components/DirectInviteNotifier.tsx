import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";

import { ToastAction } from "@/components/ui/toast";
import { useInviteInbox } from "@/concord/hooks/useDirectInvites";
import { toast } from "@/hooks/useToast";

/**
 * Passive notifier for received direct (gift-wrapped) Concord invites
 * (CORD-05 §6). Replaces the blocking one-at-a-time modal: a received invite
 * no longer interrupts — it lands in the routed inbox (`/invites`) with a rail
 * badge, and a new arrival raises a single non-blocking toast pointing there.
 *
 * Nothing here decrypts or reacts on the network; it reads the same parked
 * inbox the rail and the page do. Consent still happens only at the explicit
 * Accept on the inbox page — the toast is a pointer, not a decision.
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

  // Already looking at them — don't toast what the user is reading.
  const onInbox = pathname === "/invites";

  useEffect(() => {
    if (onInbox) {
      // Mark everything currently pending as announced so leaving the page
      // doesn't immediately toast the invites just seen.
      for (const it of items) announced.current.add(it.invite.wrapId);
      return;
    }

    const fresh = items.filter((it) => it.unread && !announced.current.has(it.invite.wrapId));
    if (fresh.length === 0) return;
    for (const it of fresh) announced.current.add(it.invite.wrapId);

    const newest = fresh[0].invite;
    const title =
      fresh.length > 1
        ? `${fresh.length} new community invites`
        : newest.catchUp
          ? "Community keys updated"
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
  }, [items, onInbox]);

  return null;
}

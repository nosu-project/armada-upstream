import { Check, ChevronLeft, Loader2, MailPlus, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as nip19 from "nostr-tools/nip19";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import { BannedFromCommunityError } from "@/concord/hooks/useCommunityActions";
import {
  useAcceptDirectInvite,
  useDeclineDirectInvite,
  useInviteInbox,
  type InviteInboxItem,
  type ParkedInvite,
} from "@/concord/hooks/useDirectInvites";
import { concordInviteReadKey, useReadState } from "@/hooks/useReadState";
import { toast } from "@/hooks/useToast";
import { shortTimeAgo } from "@/lib/formatTime";
import { cn } from "@/lib/utils";

/**
 * The seal-verified sender as an npub. Rendered WITHOUT any profile fetch — the
 * invite inbox keeps the modal's deliberate invariant that nothing beyond the
 * seal-verified sender and the bundle's claimed name reaches the screen before
 * the user decides, so an unknown sender's kind-0 (and its remote avatar, a
 * tracking pixel) never renders here.
 */
function senderLabel(pubkeyHex: string): string {
  try {
    return `${nip19.npubEncode(pubkeyHex).slice(0, 16)}…`;
  } catch {
    return `${pubkeyHex.slice(0, 16)}…`;
  }
}

/** One invite in the master list: who sent it, for what, and when. */
function InviteRow({
  item,
  selected,
  onOpen,
}: {
  item: InviteInboxItem;
  selected: boolean;
  onOpen: (item: InviteInboxItem) => void;
}) {
  const { invite, unread } = item;
  const isCatchUp = Boolean(invite.catchUp);

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors clip-corner-lg",
        selected ? "bg-primary/10" : "hover:bg-foreground/5",
        unread && !selected && "bg-primary/[0.06]",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center clip-corner-lg bg-secondary/60 text-success">
        <ShieldCheck className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("min-w-0 truncate text-sm", unread ? "font-semibold" : "font-medium")}>
            {invite.name}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {shortTimeAgo(invite.receivedAt)}
          </span>
        </div>
        <p
          className={cn(
            "mt-0.5 line-clamp-2 break-all text-sm",
            unread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {isCatchUp ? "Updated community keys" : "Invited you"} · from {senderLabel(invite.sender)}
        </p>
      </div>
      {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
    </button>
  );
}

/**
 * The detail pane for the selected invite — the consent surface, carrying the
 * same copy and Accept/Decline semantics the blocking modal used to. Accepting
 * keeps the keys (records the entry in the Community List vault) and announces
 * a Guestbook Join; declining tombstones it so it stops re-appearing. A
 * catch-up (a key update for a community you're already in) declines by local
 * dismissal only — never a tombstone, which would leave the community.
 */
function InviteDetail({
  invite,
  onDone,
  onBack,
}: {
  invite: ParkedInvite;
  /** The invite left the inbox (accepted or declined) — drop the selection. */
  onDone: () => void;
  /** Mobile back to the list. */
  onBack: () => void;
}) {
  const { mutateAsync: accept, isPending: accepting } = useAcceptDirectInvite();
  const { mutateAsync: decline, isPending: declining } = useDeclineDirectInvite();
  const navigate = useNavigate();
  const busy = accepting || declining;
  const isCatchUp = Boolean(invite.catchUp);

  const handleDecline = async () => {
    // A CATCH-UP is a key update for a community I'm already in — declining must
    // NOT tombstone (that would leave the community). The parked copy is simply
    // dismissed by the accept/decline round below re-scanning; here we just drop
    // it from view. A fresh invite tombstones so it stops re-appearing.
    if (!isCatchUp) {
      try {
        await decline({ communityId: invite.communityId });
      } catch {
        // Best-effort; drop it from view regardless.
      }
    }
    onDone();
  };

  const handleAccept = async () => {
    try {
      const { communityId, name } = await accept({ invite });
      toast({ title: "Joined encrypted community", description: name });
      navigate(`/c/${encodeURIComponent(communityId)}`);
    } catch (e) {
      if (e instanceof BannedFromCommunityError) {
        toast({
          title: "You're banned",
          description: "You can't join this community.",
          variant: "destructive",
        });
        await handleDecline();
        return;
      }
      toast({
        title: "Couldn't join",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 safe-area-top h-full">
      <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to invites"
          className="size-9 touch:size-11 shrink-0 sidebar:hidden"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <ShieldCheck className="size-5 text-success shrink-0" />
        <h1 className="font-semibold truncate leading-tight">
          {isCatchUp ? "Updated community keys" : "Encrypted community invite"}
        </h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center p-4">
        <div className="flex w-full max-w-md flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <ArmadaCrest size={72} />
            <div className="space-y-1">
              <h2 className="font-mono font-bold lowercase tracking-tight text-foreground">
                {isCatchUp ? "additional channel keys" : "encrypted community invite"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {isCatchUp ? (
                  <>
                    Someone sent you keys to private channels in a community you're already in.
                    Accepting adds those channels; it changes nothing else about your membership.
                  </>
                ) : (
                  <>
                    You've been handed the keys to an end-to-end-encrypted community. Accepting lets
                    you read and post; no host can see its messages.
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="w-full clip-corner-lg border border-chrome bg-secondary/40 p-4">
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck className="size-4 shrink-0 text-success" />
              <span className="min-w-0 truncate">{invite.name}</span>
            </div>
            <div className="mt-1 break-all text-xs text-muted-foreground">
              from {senderLabel(invite.sender)}
            </div>
          </div>

          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" className="clip-corner-lg" onClick={handleDecline} disabled={busy}>
              {declining ? <Loader2 className="size-4 mr-2 animate-spin" /> : <X className="size-4 mr-2" />}
              {isCatchUp ? "Not now" : "Decline"}
            </Button>
            <Button className="clip-corner-lg" onClick={handleAccept} disabled={busy}>
              {accepting ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Check className="size-4 mr-2" />
              )}
              {accepting ? (isCatchUp ? "Adding…" : "Joining…") : isCatchUp ? "Add channels" : "Accept"}
            </Button>
          </div>
        </div>
      </div>
      <ArmadaCrestKeyframes />
    </div>
  );
}

/**
 * The direct-invite inbox: every gift-wrapped Concord invite (CORD-05 §6) that
 * hasn't been accepted or declined, as a mail-client-style master/detail list
 * rather than the queue of blocking modals it used to be. Selecting an invite
 * opens its consent surface (Accept/Decline) inline — a two-pane master/detail
 * on desktop, a list→detail push on mobile.
 *
 * Opening the page marks the whole inbox seen (the rail badge clears); the
 * individual accept/decline is still an explicit, per-invite consent action.
 */
export function InvitesPage() {
  const { items, unreadCount } = useInviteInbox();
  const { markRead } = useReadState();
  const [selectedWrapId, setSelectedWrapId] = useState<string | undefined>(undefined);

  const selected = items.find((it) => it.invite.wrapId === selectedWrapId)?.invite;

  // Opening the inbox (or a fresh invite arriving while it's open) marks
  // everything seen — one high-water mark for the whole inbox, so the rail
  // badge clears. Consent is still separate: seeing an invite isn't accepting
  // it. `markRead` no-ops when the stored stamp is already past the newest.
  const newest = items[0]?.invite.receivedAt ?? 0;
  useEffect(() => {
    if (newest > 0) markRead(concordInviteReadKey(), newest);
  }, [newest, markRead]);

  // Drop a stale selection when its invite leaves the inbox (accepted/declined
  // elsewhere, or the scan refreshed it out).
  useEffect(() => {
    if (selectedWrapId && !items.some((it) => it.invite.wrapId === selectedWrapId)) {
      setSelectedWrapId(undefined);
    }
  }, [items, selectedWrapId]);

  return (
    <SwipeReveal
      open={!selected}
      onReveal={() => setSelectedWrapId(undefined)}
      onClose={() => undefined}
      underlay={
        <>
          <ServerRail />
          <div className="flex flex-1 sidebar:flex-none sidebar:w-80 min-w-0 flex-col safe-area-top h-full">
            <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
              <MailPlus className="size-5 text-muted-foreground shrink-0" />
              <h1 className="font-semibold truncate leading-tight">Invites</h1>
              {unreadCount > 0 && (
                <span className="ml-1 flex min-w-5 h-5 px-1.5 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold leading-none">
                  {unreadCount}
                </span>
              )}
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
              {items.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-3 py-16 text-center text-muted-foreground">
                  <MailPlus className="size-10 opacity-40" />
                  <p className="text-sm">
                    No invites. When someone hands you the keys to an encrypted community, it&rsquo;ll
                    show up here.
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {items.map((item) => (
                    <InviteRow
                      key={item.invite.wrapId}
                      item={item}
                      selected={item.invite.wrapId === selectedWrapId}
                      onOpen={(it) => setSelectedWrapId(it.invite.wrapId)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      }
    >
      <main className="flex flex-1 min-w-0 flex-col bg-background h-full">
        {selected ? (
          <InviteDetail
            key={selected.wrapId}
            invite={selected}
            onDone={() => setSelectedWrapId(undefined)}
            onBack={() => setSelectedWrapId(undefined)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3 max-w-sm">
              <MailPlus className="size-12 opacity-30" />
              <p className="text-sm">
                {items.length === 0 ? "You have no pending invites." : "Select an invite to review it."}
              </p>
            </div>
          </div>
        )}
      </main>
    </SwipeReveal>
  );
}

export default InvitesPage;

import { Loader2, Shield } from "lucide-react";
import { useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { describeAttempts, type SuspiciousActor } from "@/concord/lib/auditLog";
import type { FoldedControl } from "@/concord/lib/control";
import type { Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";

/** One offender: who they are, what they tried, and the button that ends it. */
function ActorRow({
  actor,
  onBan,
  busy,
}: {
  actor: SuspiciousActor;
  onBan: (target: string) => void;
  busy: boolean;
}) {
  const author = useAuthor(actor.author);
  const name = useScopedDisplayName(actor.author, author.data?.metadata);
  return (
    <li className="clip-corner-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="text-sm">
        <span className="font-semibold">
          <DisplayName pubkey={actor.author} name={name} />
        </span>{" "}
        is not an admin here, but has tried to make{" "}
        <span className="font-semibold">{describeAttempts(actor.attempts)}</span>.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        None of it worked, so nothing in the community has actually changed. Banning them also
        changes the community's keys, so they lose access rather than just being silenced.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || actor.banned}
          onClick={() => onBan(actor.author)}
        >
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          {actor.banned ? "Already banned" : "Ban and lock them out"}
        </Button>
      </div>
    </li>
  );
}

/**
 * The control-plane watchdog's alert: a member with no standing is writing
 * control editions. Sits above the community's nav rows, only for viewers who
 * can act, and only off a complete sweep (see useSuspiciousActivity).
 *
 * `ban` is the page's existing moderation mutation — banning already rotates
 * when the community is private, so there is no separate remedy to build here.
 */
export function SuspiciousActivityBanner({
  community,
  folded,
  ban,
}: {
  community: Community | undefined;
  folded: FoldedControl | undefined;
  ban: (args: { target: string; forceRotate?: boolean }) => Promise<{ rekeyed: boolean; publicBan: boolean }>;
}) {
  const { actors, unreadable, flooded, alert, dismiss } = useSuspiciousActivity(community, folded);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  if (!alert) return null;

  const onBan = (target: string) => {
    setBusy(target);
    // Always rotate from here, public community or not: against control-plane
    // abuse the rotation is the remedy, not a side effect. A banlist alone
    // leaves the flooder holding the root they mint junk with.
    ban({ target, forceRotate: true })
      .then((r) => {
        toast({
          title: "Member banned",
          description: r.rekeyed
            ? "The community's keys were changed, so they no longer have access."
            : "They can no longer act in this community.",
        });
        setOpen(false);
      })
      .catch((e) => toast({ title: "Couldn't remove them", description: e instanceof Error ? e.message : undefined, variant: "destructive" }))
      .finally(() => setBusy(undefined));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
          "bg-destructive/15 text-destructive font-semibold hover:bg-destructive/25",
        )}
      >
        <Shield className="size-4 shrink-0" />
        <span className="truncate flex-1 min-w-0">Suspicious Activity</span>
        {actors.length > 1 ? (
          <span className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold leading-none">
            {actors.length}
          </span>
        ) : null}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="size-4 text-destructive" />
              Suspicious activity
            </DialogTitle>
          </DialogHeader>
          {flooded ? (
            // The read stopped on our own limit with history still unread. In
            // a healthy community that never happens, so it is worth stating
            // ahead of everything else: it is the one symptom that also
            // explains why nobody below is named.
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                This community's history has grown so large we can no longer read all of it. That
                takes deliberate effort, and only a member can do it, so someone here is burying it
                on purpose.
              </p>
              <p>
                Until it is cleared up, roles and bans may be out of date on new devices, and we
                cannot say for certain who is responsible. Changing the community's keys is what
                stops it, but only once they have been removed, so it is worth closing the community
                to new joins and reviewing anyone who joined recently or has never spoken.
              </p>
            </div>
          ) : actors.length === 0 ? (
            // Junk names nobody by construction: it is signed with the key every
            // member shares. Say that plainly, because "we can't tell who" is
            // the whole reason the advice is prune-and-rotate rather than ban.
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Someone inside this community is flooding it with junk. They can only do that
                because they are a member: the events are signed with a key every member shares,
                which is also why there is no way to tell which of them it is.
              </p>
              <p>
                Changing the community's keys is what stops it, but only once they have been
                removed. It is worth closing the community to new joins first, then reviewing anyone
                who joined recently, has never spoken, or you already had doubts about.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {actors.length === 1 ? "Someone is" : `${actors.length} people are`} trying to perform
              admin actions in this community without permission. What should we do about them?
            </p>
          )}
          <ul className="space-y-2">
            {actors.map((actor) => (
              <ActorRow key={actor.author} actor={actor} onBan={onBan} busy={busy === actor.author} />
            ))}
          </ul>
          {unreadable > 0 ? (
            <p className="text-xs text-muted-foreground">
              Also seen:{" "}
              <span className="font-semibold text-destructive">{unreadable} unreadable events</span>,
              slowing everyone's sync.
              {actors.length > 0
                ? // The junk names nobody, so it may be a DIFFERENT member than
                  // the one above — say so, or banning them reads as the whole fix.
                  " These can't be traced to anyone, so banning the member above may not stop them. It is worth removing anyone else you don't trust, especially members who joined recently or have never spoken."
                : ""}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                dismiss();
                setOpen(false);
              }}
            >
              {/* With nobody to name there is no offer to decline, only
                  something to take in — so the control acknowledges rather
                  than dismisses. */}
              {actors.length === 0 ? "Understood" : "Ignore for now"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

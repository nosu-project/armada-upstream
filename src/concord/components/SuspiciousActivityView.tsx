import { Ban, Clock, Copy, Loader2, Shield, UserMinus } from "lucide-react";
import { useState } from "react";
import { nip19 } from "nostr-tools";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { useTimeTravelers } from "@/concord/hooks/useTimeTravelers";
import { describeAttempts, type SuspiciousActor } from "@/concord/lib/auditLog";
import { describeAhead, travelerRank, type TimeTraveler } from "@/concord/lib/timeTravelers";
import type { FoldedControl } from "@/concord/lib/control";
import type { Channel, Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";

/** One control-plane offender: who they are, what they tried, and the remedy. */
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
    <li className="clip-corner-lg bg-destructive/10 p-3">
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
 * One "time traveler": a member whose messages are dated well ahead of the
 * local clock. Usually an innocent wrong device clock, but a future stamp is
 * also a spam/griefing vector (a held message that jumps to the top the instant
 * its time arrives), so a moderator gets the real kick/ban remedy here too,
 * framed as "if this is abuse" rather than an accusation.
 */
function TravelerRow({
  traveler,
  onKick,
  onBan,
  canKick,
  canBan,
  busy,
}: {
  traveler: TimeTraveler;
  onKick: (target: string) => void;
  onBan: (target: string) => void;
  canKick: boolean;
  canBan: boolean;
  busy: boolean;
}) {
  const author = useAuthor(traveler.author);
  const name = useScopedDisplayName(traveler.author, author.data?.metadata);
  const picture = author.data?.metadata?.picture;

  const copyNpub = () => {
    try {
      const npub = nip19.npubEncode(traveler.author);
      void navigator.clipboard?.writeText(npub);
      toast({ title: "Copied their npub" });
    } catch {
      toast({ title: "Couldn't copy", variant: "destructive" });
    }
  };

  return (
    <li className="clip-corner-lg bg-primary/10 p-3">
      <div className="flex items-start gap-3">
        <Avatar className="size-9 shrink-0">
          {picture ? <AvatarImage src={picture} alt="" /> : null}
          <AvatarFallback className="bg-primary/20 text-primary">
            <Clock className="size-4" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-semibold">
              <DisplayName pubkey={traveler.author} name={name} />
            </span>
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
              {travelerRank(traveler.aheadMs)}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Broadcasting from <span className="font-semibold text-foreground">{describeAhead(traveler.aheadMs)}</span> ahead of
            you{traveler.count > 1 ? ` (${traveler.count} messages)` : ""}.
          </p>
          {traveler.sample ? (
            <p className="mt-1 line-clamp-2 rounded bg-background/50 px-2 py-1 text-xs italic text-muted-foreground">
              “{traveler.sample}”
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={copyNpub}>
              <Copy className="mr-1.5 size-3.5" />
              Copy npub
            </Button>
            {canKick ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onKick(traveler.author)}>
                <UserMinus className="mr-1.5 size-3.5" />
                Kick
              </Button>
            ) : null}
            {canBan ? (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => onBan(traveler.author)}>
                {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Ban className="mr-1.5 size-3.5" />}
                Ban
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * The control-plane watchdog as a full pane (the `suspicious` route), replacing
 * the old cramped dialog. Two surfaces share it: the control-plane abuse rows
 * (a member with no standing writing editions) and the "time traveler" flag (a
 * member whose messages are dated in the future). Both are actionable with the
 * real kick/ban remedy; a future stamp is an innocent wrong clock most of the
 * time but also a spam vector, so the moderator decides. Reached from the red
 * sidebar alert, which only shows when there is something here to see.
 *
 * `ban`/`kick` are the page's existing moderation mutations (banning already
 * rotates the keys when the community is private); `canBan`/`canKick` gate the
 * per-traveler remedy against the roster.
 */
export function SuspiciousActivityView({
  community,
  channels,
  folded,
  ban,
  kick,
  canBan,
  canKick,
}: {
  community: Community | undefined;
  channels: Channel[];
  folded: FoldedControl | undefined;
  ban: (args: { target: string; forceRotate?: boolean }) => Promise<{ rekeyed: boolean; publicBan: boolean }>;
  kick: (target: string) => Promise<void>;
  canBan: (target: string) => boolean;
  canKick: (target: string) => boolean;
}) {
  const { actors, unreadable, flooded, alert, dismiss } = useSuspiciousActivity(community, folded);
  const travelers = useTimeTravelers(community, channels);
  const [busy, setBusy] = useState<string | undefined>(undefined);

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
      })
      .catch((e) =>
        toast({
          title: "Couldn't remove them",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
      )
      .finally(() => setBusy(undefined));
  };

  const onKick = (target: string) => {
    setBusy(target);
    kick(target)
      .then(() => toast({ title: "Member kicked" }))
      .catch((e) =>
        toast({
          title: "Couldn't kick them",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
      )
      .finally(() => setBusy(undefined));
  };

  const nothing = !alert && travelers.length === 0;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-4 pb-24">
      <div className="flex items-center gap-2">
        <Shield className="size-5 text-destructive" />
        <h2 className="text-lg font-semibold">Suspicious activity</h2>
      </div>

      {nothing ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-foreground/5 px-4 py-12 text-center text-sm text-muted-foreground">
          <Shield className="size-8 opacity-40" />
          <p className="max-w-sm">
            All clear. Members acting without permission, or arriving from the future with a badly
            wrong clock, show up here.
          </p>
        </div>
      ) : (
        <>
          {alert ? (
            <section className="space-y-3">
              {flooded ? (
                // The read stopped on our own limit with history still unread.
                // In a healthy community that never happens, so it is worth
                // stating ahead of everything else: it is the one symptom that
                // also explains why nobody below is named.
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    This community's history has grown so large we can no longer read all of it. That
                    takes deliberate effort, and only a member can do it, so someone here is burying
                    it on purpose.
                  </p>
                  <p>
                    Until it is cleared up, roles and bans may be out of date on new devices, and we
                    cannot say for certain who is responsible. Changing the community's keys is what
                    stops it, but only once they have been removed, so it is worth closing the
                    community to new joins and reviewing anyone who joined recently or has never
                    spoken.
                  </p>
                </div>
              ) : actors.length === 0 ? (
                // Junk names nobody by construction: it is signed with the key
                // every member shares. Say that plainly, because "we can't tell
                // who" is the whole reason the advice is prune-and-rotate.
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    Someone inside this community is flooding it with junk. They can only do that
                    because they are a member: the events are signed with a key every member shares,
                    which is also why there is no way to tell which of them it is.
                  </p>
                  <p>
                    Changing the community's keys is what stops it, but only once they have been
                    removed. It is worth closing the community to new joins first, then reviewing
                    anyone who joined recently, has never spoken, or you already had doubts about.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {actors.length === 1 ? "Someone is" : `${actors.length} people are`} trying to
                  perform admin actions in this community without permission. What should we do about
                  them?
                </p>
              )}

              {actors.length > 0 ? (
                <ul className="space-y-2">
                  {actors.map((actor) => (
                    <ActorRow key={actor.author} actor={actor} onBan={onBan} busy={busy === actor.author} />
                  ))}
                </ul>
              ) : null}

              {unreadable > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Also seen:{" "}
                  <span className="font-semibold text-destructive">{unreadable} unreadable events</span>,
                  slowing everyone's sync.
                  {actors.length > 0
                    ? " These can't be traced to anyone, so banning the member above may not stop them. It is worth removing anyone else you don't trust, especially members who joined recently or have never spoken."
                    : ""}
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  {actors.length === 0 ? "Understood" : "Ignore for now"}
                </Button>
              </div>
            </section>
          ) : null}

          {travelers.length > 0 ? (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-primary" />
                <h3 className="text-sm font-semibold text-primary">
                  {travelers.length === 1 ? "Time traveler detected" : `${travelers.length} time travelers detected`}
                </h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Messages dated in the future stay hidden until their timestamp comes around. Usually
                a wrong device clock, but if one is being used to jump the timeline, kick or ban.
              </p>
              <ul className="space-y-2">
                {travelers.map((t) => (
                  <TravelerRow
                    key={t.author}
                    traveler={t}
                    onKick={onKick}
                    onBan={onBan}
                    canKick={canKick(t.author)}
                    canBan={canBan(t.author)}
                    busy={busy === t.author}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

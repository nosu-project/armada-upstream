import { ServerCrash, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchBuzzJoinPolicy,
  claimBuzzInvite,
  parseBuzzInviteUrl,
  type BuzzInvite,
} from "@/buzz/invite";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { toast } from "@/hooks/useToast";
import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { relayToHttpUrl, relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface BuzzInviteEmbedProps {
  /** The full invite URL as it appeared in the message. */
  url: string;
  className?: string;
}

/**
 * Discord-style "join" card for a Buzz / NIP-29 relay invite link posted in
 * chat (`https://<host>/invite/<code>`). Unlike a Concord invite, this is an
 * HTTP claim against the relay: we preview the relay's NIP-11 name/icon and
 * offer a one-tap Join. A relay that requires a join policy sends the user to
 * the full invite page, where the terms can be shown and accepted.
 */
export function BuzzInviteEmbed({ url, className }: BuzzInviteEmbedProps) {
  const invite = parseBuzzInviteUrl(url);
  if (!invite) {
    return <BuzzInviteTombstone message="This invite link is malformed." className={className} />;
  }
  return <BuzzInviteCard invite={invite} className={className} />;
}

interface RelayPreview {
  name?: string;
  description?: string;
  icon?: string;
}

function BuzzInviteCard({
  invite,
  className,
}: {
  invite: BuzzInvite;
  className?: string;
}) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { mutateAsync: updateList } = useUpdateUserGroupList();
  const servers = useNip29Servers();

  const [preview, setPreview] = useState<RelayPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const alreadyJoined = servers.includes(invite.relayUrl);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    fetch(relayToHttpUrl(invite.relayUrl), {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(8000),
    })
      .then((res): Promise<RelayPreview> => (res.ok ? res.json() : Promise.resolve({})))
      .then((info) => {
        if (!cancelled) setPreview(info ?? {});
      })
      .catch(() => {
        // A blocked/failed NIP-11 fetch must not turn a joinable invite into an
        // error card — the claim is an HTTP POST that CORS doesn't gate the same
        // way, so fall back to the bare host as the name.
        if (!cancelled) setPreview({});
      });
    return () => {
      cancelled = true;
    };
  }, [invite.relayUrl]);

  const open = () => navigate(`/s/${relayToRouteParam(invite.relayUrl)}`);

  const doJoin = async () => {
    if (!user) {
      toast({ title: "Sign in to join", description: "Create an account or sign in to accept this invite." });
      return;
    }
    setJoining(true);
    setError(null);
    try {
      // A relay with a join policy needs the terms shown and accepted first —
      // hand off to the full invite page rather than claim blind here.
      const policy = await fetchBuzzJoinPolicy(invite.origin).catch(() => undefined);
      if (policy) {
        navigate(`/invite/${encodeURIComponent(invite.code)}?r=${encodeURIComponent(invite.host)}`);
        return;
      }
      await claimBuzzInvite(user.signer, invite);
      // The kind 10009 list is the only store for added servers, so this write
      // IS the add — awaited so a rejected publish surfaces as an error rather
      // than a rail icon that vanishes at the next sync.
      await updateList({ type: "add-server", url: invite.relayUrl });
      toast({ title: "Joined", description: preview?.name || invite.host });
      navigate(`/s/${relayToRouteParam(invite.relayUrl)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join with that invite link.");
    } finally {
      setJoining(false);
    }
  };

  if (error) {
    return <BuzzInviteTombstone message={error} className={className} />;
  }
  if (!preview) {
    return <BuzzInviteSkeleton className={className} />;
  }

  const name = preview.name || invite.host;

  return (
    <div
      className={cn(
        "block max-w-sm w-full rounded-2xl border border-border bg-secondary/30 overflow-hidden my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3.5 py-3 space-y-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          You've been invited to join a server
        </p>

        <div className="flex items-center gap-3 min-w-0">
          <Avatar className="size-11 clip-corner-lg shrink-0">
            {preview.icon && <AvatarImage src={preview.icon} alt={name} className="object-cover" />}
            <AvatarFallback className="clip-corner-lg bg-primary/20 text-primary font-semibold">
              {name.slice(0, 2).toUpperCase() || "??"}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <p className="font-semibold truncate leading-tight">{name}</p>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Users className="size-3.5 shrink-0" />
                {invite.host}
              </span>
            </div>
          </div>
        </div>

        {alreadyJoined ? (
          <Button variant="secondary" className="w-full clip-corner-lg" onClick={open}>
            Open
          </Button>
        ) : (
          <Button className="w-full clip-corner-lg" onClick={doJoin} disabled={joining}>
            {joining ? "Joining…" : "Join"}
          </Button>
        )}
      </div>
    </div>
  );
}

function BuzzInviteSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "max-w-sm w-full rounded-2xl border border-border bg-secondary/30 overflow-hidden my-1.5",
        className,
      )}
    >
      <div className="px-3.5 py-3 space-y-2.5">
        <Skeleton className="h-2.5 w-48" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 clip-corner-lg shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="h-9 w-full clip-corner-lg" />
      </div>
    </div>
  );
}

function BuzzInviteTombstone({ message, className }: { message: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 max-w-sm rounded-2xl border border-dashed border-border px-3.5 py-4 my-1.5 text-muted-foreground",
        className,
      )}
    >
      <ServerCrash className="size-4 shrink-0" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

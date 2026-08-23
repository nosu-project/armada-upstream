import { Ban, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { ServerRail } from "@/components/layout/ServerRail";
import { JoinButton } from "@/components/auth/JoinButton";
import { Button } from "@/components/ui/button";
import {
  BannedFromCommunityError,
  useCommunityActions,
  type InvitePreview,
} from "@/concord/hooks/useCommunityActions";
import { InviteDetail } from "@/concord/pages/InvitesPage";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { parseInviteRoute } from "@/concord/lib/invite";

/**
 * Landing page for a Concord invite link — `/invite/<naddr>#<fragment>`
 * (CORD-05). The path names the bundle's addressable coordinate; the fragment
 * carries the 16-byte unlock token + bootstrap relays and never reaches any
 * server.
 *
 * The link resolves its sealed bundle and renders the SAME consent surface a
 * gift-wrapped Direct Invite gets ({@link InviteDetail}) — the community's
 * name, artwork, channel count, relays and current members — and asks before
 * joining. It used to auto-join the moment the link was opened while signed in;
 * now Accept is an explicit act, so what the keys grant is on screen first.
 * Accepting fetches the bundle, verifies the self-certifying owner commitment,
 * records the keys, and announces the Guestbook Join.
 */
export function InvitePage() {
  const { naddr } = useParams<{ naddr: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { preview, join, isJoining } = useCommunityActions();
  const [error, setError] = useState<string | null>(null);
  const [banned, setBanned] = useState(false);
  const [resolved, setResolved] = useState<InvitePreview | null>(null);

  const fragment = (location.hash || window.location.hash).replace(/^#/, "").trim();
  const invite = naddr && fragment ? parseInviteRoute(naddr, fragment) : undefined;

  // Look before you leap: resolve the bundle even before sign-in, so the
  // consent surface can paint the community's face while the account is added.
  useEffect(() => {
    if (!naddr || !fragment) {
      setError("This invite link is missing its secret. Ask for a fresh link.");
      return;
    }
    if (!invite) {
      setError("This invite link is malformed or from a newer client.");
      return;
    }
    let cancelled = false;
    setError(null);
    preview({ invite })
      .then((p) => {
        if (!cancelled) setResolved(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load that invite link.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naddr, fragment]);

  const handleAccept = async () => {
    if (!invite) return;
    try {
      const { communityId, name } = await join({ invite });
      toast({ title: "Encrypted community joined", description: name });
      navigate(`/c/${encodeURIComponent(communityId)}`, { replace: true });
    } catch (e) {
      setBanned(e instanceof BannedFromCommunityError);
      setError(e instanceof Error ? e.message : "Couldn't join with that invite link.");
    }
  };

  if (error) {
    return (
      <>
        <ServerRail />
        <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
          {banned ? (
            <Ban className="size-12 text-destructive" />
          ) : (
            <ShieldCheck className="size-12 text-muted-foreground" />
          )}
          <h1 className="text-2xl font-bold">{banned ? "You’re banned" : "Invite link didn’t work"}</h1>
          <p className="max-w-md text-muted-foreground">{error}</p>
          <Button asChild>
            <Link to="/">Back to base</Link>
          </Button>
        </main>
      </>
    );
  }

  if (!resolved) {
    return (
      <>
        <ServerRail />
        <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground">Opening the invite…</p>
        </main>
      </>
    );
  }

  return (
    <>
      <ServerRail />
      <main className="flex flex-1 min-w-0 flex-col bg-background h-full">
        <InviteDetail
          bundle={resolved.bundle}
          communityId={resolved.communityId}
          name={resolved.name}
          accepting={isJoining}
          declining={false}
          onAccept={handleAccept}
          onDecline={() => navigate("/")}
          signInSlot={
            user ? undefined : (
              <JoinButton
                size="lg"
                className="h-12 min-w-0 flex-1 clip-corner-lg text-base font-medium"
              >
                Sign in to accept
              </JoinButton>
            )
          }
        />
      </main>
    </>
  );
}

export default InvitePage;

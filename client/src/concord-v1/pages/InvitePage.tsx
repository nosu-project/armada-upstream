import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ServerRail } from "@/components/layout/ServerRail";
import { JoinButton } from "@/components/auth/JoinButton";
import { Button } from "@/components/ui/button";
import { useConcordActions } from "@/concord-v1/hooks/useConcordActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";

/**
 * Landing page for a clicked invite link (`/invite#<fragment>`). The invite's
 * secret rides in the URL `#fragment`, which by the way the web works never
 * reaches the relay — only this client reads it. We hand the whole fragment to
 * `joinViaInvite` (it re-parses the v2 binary blob), then redirect into the
 * joined community. Pasting a link still works via the AddDialog join step;
 * this just makes the link itself land somewhere useful instead of a 404.
 */
export function InvitePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const { joinViaInvite } = useConcordActions();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  // The fragment is the raw invite payload. `useLocation().hash` includes the
  // leading "#"; fall back to window in case the router strips it.
  const fragment = (location.hash || window.location.hash).replace(/^#/, "").trim();

  useEffect(() => {
    if (!fragment) {
      setError("This invite link is missing its secret. Ask for a fresh link.");
      return;
    }
    if (!user) return; // wait for sign-in
    if (attempted.current) return;
    attempted.current = true;

    (async () => {
      try {
        // `token` carries the full fragment; `joinViaInvite` decodes it.
        const community = await joinViaInvite({ invite: { token: fragment, relays: [] } });
        toast({ title: "Encrypted chat joined", description: community.name });
        navigate(`/c1/${encodeURIComponent(community.communityId)}`, { replace: true });
      } catch (e) {
        attempted.current = false; // allow a retry
        setError(e instanceof Error ? e.message : "Couldn't join with that invite link.");
      }
    })();
  }, [fragment, user, joinViaInvite, navigate]);

  return (
    <>
      <ServerRail />
      <main className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
        <ShieldCheck className="size-12 text-success" />
        {error ? (
          <>
            <h1 className="text-2xl font-bold">Invite link didn’t work</h1>
            <p className="max-w-md text-muted-foreground">{error}</p>
            <Button asChild>
              <Link to="/">Back to base</Link>
            </Button>
          </>
        ) : !user ? (
          <>
            <h1 className="text-2xl font-bold">You’re invited to a private chat</h1>
            <p className="max-w-md text-muted-foreground">
              Create an account or sign in to accept the invite.
            </p>
            <JoinButton size="lg" className="h-12 w-full max-w-xs clip-corner-lg text-base font-medium" />
          </>
        ) : (
          <>
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Joining the encrypted chat…</p>
          </>
        )}
      </main>
    </>
  );
}

export default InvitePage;

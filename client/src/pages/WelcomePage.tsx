import { useState } from "react";
import { Link, Navigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import LoginDialog from "@/components/auth/LoginDialog";
import SignupDialog from "@/components/auth/SignupDialog";
import { AddDialog } from "@/components/dialogs/AddDialog";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";

/**
 * First-run onboarding for the standalone (rogue) client.
 *
 * A bundled desktop build ships with no pinned relay, so a fresh install starts
 * with no servers. This screen prompts the user to log in and add their first
 * server. (On a hosted deployment with pinned platform relays, the home
 * redirect never lands here.)
 *
 * Clean and spacious, echoing the OG card: the crest, the lowercase wordmark
 * and `$` tagline, then a single "Join" button (same pattern as the channel
 * sidebar) that opens login when signed out, or add-server once signed in.
 */
export function WelcomePage() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const online = useOnlineStatus();
  const [joinOpen, setJoinOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Once signed in, leave the welcome screen for a real server: the pinned
  // platform relay on a hosted build, or the user's first added server.
  const firstServer = PLATFORM_RELAYS[0] ?? config.addedRelays[0];
  if (user && !online) {
    return <Navigate to="/mesh" replace />;
  }
  if (user && firstServer) {
    return <Navigate to={`/s/${relayToRouteParam(firstServer)}`} replace />;
  }

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center gap-12 px-6 py-16 safe-area-top safe-area-bottom">
        <div className="flex flex-col items-center gap-8">
          <ArmadaCrest size={150} />
          <BrandMark />
        </div>

        <div className="w-full max-w-sm">
          <Button
            size="lg"
            onClick={() => (user ? setAddOpen(true) : setJoinOpen(true))}
            className="h-12 w-full clip-corner-lg text-base font-medium"
          >
            Join
          </Button>
          <Link
            to="/about"
            className="mt-4 block text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            How does Armada work?
          </Link>
        </div>

        <LoginDialog
          isOpen={joinOpen}
          onClose={() => setJoinOpen(false)}
          onLogin={() => setJoinOpen(false)}
          onSignupClick={() => {
            setJoinOpen(false);
            setSignupOpen(true);
          }}
        />
        <SignupDialog isOpen={signupOpen} onClose={() => setSignupOpen(false)} />
        <AddDialog open={addOpen} onOpenChange={setAddOpen} />
      </div>

      <ArmadaCrestKeyframes />
    </main>
  );
}

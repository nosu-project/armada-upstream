import { useState } from "react";
import { Link, Navigate } from "react-router-dom";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import LoginDialog from "@/components/auth/LoginDialog";
import SignupDialog from "@/components/auth/SignupDialog";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";

/**
 * First-run onboarding — the logged-OUT landing/join screen.
 *
 * A signed-out visitor sees the crest, wordmark and a single "Join" button
 * that opens login. A signed-in user is always redirected away (to a server,
 * or the main app shell) — they never see this screen, so there's no
 * "add server" affordance here; that lives in the server rail's "+" button.
 *
 * Clean and spacious, echoing the OG card: the crest, the lowercase wordmark
 * and `$` tagline, then a single "Join" button.
 */
export function WelcomePage() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const { mesh } = useMeshTransport();
  const online = useOnlineStatus();
  const { data: groupList } = useUserGroupList();
  const [joinOpen, setJoinOpen] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);

  // The welcome/join screen is for logged-OUT users only. Any signed-in user
  // is redirected off it — never left staring at "Join" (which would then
  // wrongly offer to create a community). Prefer landing on a real server:
  // the pinned platform relay on a hosted build, the user's first added
  // server, or a server from their synced kind-10009 list. `config.addedRelays`
  // is just the fast/offline cache — on a fresh reinstall it starts empty and
  // is only hydrated by NostrSync a beat after login, so we consult the synced
  // list directly to redirect the moment it resolves. With no server yet, fall
  // through to the home shell (`/` → HomeRedirect picks /mesh or /dms), which
  // renders the server rail and its "+" add-server button.
  const syncedServer = groupList?.servers.find((url) => !PLATFORM_RELAYS.includes(url));
  const firstServer = PLATFORM_RELAYS[0] ?? config.addedRelays[0] ?? syncedServer;
  if (user && !online && mesh.available) {
    return <Navigate to="/mesh" replace />;
  }
  if (user && firstServer) {
    return <Navigate to={`/s/${relayToRouteParam(firstServer)}`} replace />;
  }
  if (user) {
    return <Navigate to="/" replace />;
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
            onClick={() => setJoinOpen(true)}
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
      </div>

      <ArmadaCrestKeyframes />
    </main>
  );
}

import { Plus, Server } from "lucide-react";
import { useState } from "react";
import { Navigate } from "react-router-dom";

import { LoginArea } from "@/components/auth/LoginArea";
import { AddDialog } from "@/components/dialogs/AddDialog";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { APP_NAME, PLATFORM_RELAYS, relayToRouteParam } from "@/lib/platform";

/**
 * First-run onboarding for the standalone (rogue) client.
 *
 * A bundled desktop build ships with no pinned relay, so a fresh install starts
 * with no servers. This screen prompts the user to log in and add their first
 * server. (On a hosted deployment with pinned platform relays, the home
 * redirect never lands here.)
 */
export function WelcomePage() {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const [addOpen, setAddOpen] = useState(false);

  // Once signed in, leave the welcome screen for a real server: the pinned
  // platform relay on a hosted build, or the user's first added server.
  const firstServer = PLATFORM_RELAYS[0] ?? config.addedRelays[0];
  if (user && firstServer) {
    return <Navigate to={`/s/${relayToRouteParam(firstServer)}`} replace />;
  }

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-6 p-8 text-center safe-area-top safe-area-bottom">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
          <Server className="size-8 text-primary" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Welcome to {APP_NAME}</h1>
          <p className="text-muted-foreground">
            {APP_NAME} is yours — it isn&rsquo;t tied to any single server. Log in with
            your key, then add a server to start chatting.
          </p>
        </div>

        {!user ? (
          <div className="w-full">
            <LoginArea className="w-full flex" />
          </div>
        ) : (
          <Button size="lg" onClick={() => setAddOpen(true)} className="gap-2">
            <Plus className="size-4" />
            Add a server
          </Button>
        )}

        <AddDialog open={addOpen} onOpenChange={setAddOpen} />
      </div>
    </main>
  );
}

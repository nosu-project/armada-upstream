import { ChevronLeft, FolderGit2 } from "lucide-react";
import { Navigate, useParams } from "react-router-dom";
import { useState } from "react";

import { BuzzProjectsView } from "@/buzz/BuzzProjects";
import { ChannelSidebar } from "@/components/layout/ChannelSidebar";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { ServerScopeProvider } from "@/components/ServerScopeProvider";
import { Button } from "@/components/ui/button";
import { routeParamToRelay } from "@/lib/platform";

/**
 * A Buzz workspace's Projects view (drill-down alongside a channel): the
 * relay's NIP-34 repos with their issues/patches/PRs. Mirrors GroupPage's
 * mobile drill-down — the rail + channel list sit underneath and the projects
 * pane slides over them, revealed with the back chevron or an edge swipe.
 */
export function ProjectsPage() {
  const { server } = useParams<{ server: string }>();
  const relayUrl = server ? routeParamToRelay(server) : undefined;
  const [channelsOpen, setChannelsOpen] = useState(false);

  if (!relayUrl) {
    return <Navigate to="/" replace />;
  }

  return (
    <ServerScopeProvider relayUrl={relayUrl}>
      <SwipeReveal
        open={channelsOpen}
        onReveal={() => setChannelsOpen(true)}
        onClose={() => setChannelsOpen(false)}
        underlay={
          <>
            <ServerRail />
            <ChannelSidebar
              relayUrl={relayUrl}
              onNavigate={() => setChannelsOpen(false)}
              className="flex-1 sidebar:flex-none"
            />
          </>
        }
      >
        <main className="flex-1 min-w-0 flex flex-col safe-area-top h-full">
          {/* Header — matches GroupPage's floating command bar. */}
          <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to channels"
              className="size-9 touch:size-11 shrink-0 sidebar:hidden"
              onClick={() => setChannelsOpen(true)}
            >
              <ChevronLeft className="size-5" />
            </Button>
            <FolderGit2 className="size-5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <h1 className="font-semibold truncate leading-tight">Projects</h1>
            </div>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <BuzzProjectsView relayUrl={relayUrl} />
          </div>
        </main>
      </SwipeReveal>
    </ServerScopeProvider>
  );
}

export default ProjectsPage;

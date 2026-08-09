import { Loader2, Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ActivePause } from "@/concord/lib/control";

/**
 * The banner shown above the composer while a community is paused (CORD-04 §8).
 * Everyone sees the status; a MANAGE_CHANNELS holder gets a Resume button. The
 * pause itself is enforced by the fold (non-staff messages collapse) and the
 * composer's disabled state — this is the visible signal.
 */
export function CommunityPauseBanner({
  pause,
  canManage,
  onResume,
  resuming,
}: {
  pause: ActivePause;
  canManage: boolean;
  onResume: () => void;
  resuming: boolean;
}) {
  const until = pause.until ? new Date(pause.until * 1000) : undefined;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs border-t border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400">
      <Pause className="size-4 shrink-0" />
      <span className="flex-1 min-w-0">
        This community is paused. New messages are on hold
        {until ? ` until ${until.toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}` : ""}
        {canManage ? "." : " — a moderator can resume it."}
      </span>
      {canManage && (
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2.5 shrink-0 clip-corner-lg"
          disabled={resuming}
          onClick={onResume}
        >
          {resuming ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          Resume
        </Button>
      )}
    </div>
  );
}

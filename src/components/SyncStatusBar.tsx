import { Loader2 } from "lucide-react";

import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useSyncTasks } from "@/hooks/useSyncActivity";
import { cn } from "@/lib/utils";

/**
 * A slim in-chat status line naming the background catch-up in flight —
 * "Syncing #general — 84 messages" — rendered below the chat top bar (the
 * Signal "catching up" pattern: fullscreen gate on first login, a quiet
 * inline indicator for steady-state catch-up after a wake/reconnect).
 *
 * Reads the sync-activity task list (see src/lib/syncActivity.ts): the first
 * task is shown with its live progress detail; further concurrent tasks
 * collapse into a "+n". When `priorityScope` is given (the conversation on
 * screen), a task for that conversation is surfaced ahead of unrelated
 * background work. Delayed (house useDelayedFlag pattern) so routine
 * sub-second syncs never flash it — only a genuinely slow catch-up paints.
 *
 * Visibility policy (whether to render at all — e.g. hide while the focused
 * channel is synced and live) is the parent's call; this component only
 * formats whatever is in flight.
 */
export function SyncStatusBar({
  className,
  priorityScope,
}: {
  className?: string;
  /** Wire-bus scope of the conversation on screen (e.g. `c2:<channelIdHex>`). */
  priorityScope?: string;
}) {
  const tasks = useSyncTasks();
  const shown = useDelayedFlag(tasks.length > 0, 700);

  if (!shown || tasks.length === 0) return null;
  const task = (priorityScope && tasks.find((t) => t.scope === priorityScope)) || tasks[0];
  const more = tasks.length - 1;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 sidebar:px-4 py-2 text-xs text-muted-foreground",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="truncate">
        Syncing {task.label}
        {task.detail ? ` — ${task.detail}` : "…"}
        {more > 0 && ` (+${more} more)`}
      </span>
    </div>
  );
}

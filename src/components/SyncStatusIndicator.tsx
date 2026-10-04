import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useSyncTasks } from "@/hooks/useSyncActivity";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Passive sync indicator on the channel/server icon (see
 * src/lib/syncActivity.ts). A tap-to-open Popover so it works on touch;
 * delayed so sub-second syncs never flash. `priorityScope` surfaces the on-screen conversation's task.
 */
export function SyncStatusIndicator({
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
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-chrome p-0.5 text-muted-foreground hover:text-foreground select-none",
            className,
          )}
          aria-label="Syncing. Tap for details."
        >
          {/* Border spinner, not a lucide SVG: a rotated SVG blurs at this size. */}
          <span
            className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-64 p-3 text-xs font-normal text-muted-foreground">
        <span className="text-foreground font-medium">
          Syncing {task.label}
          {task.detail ? `: ${task.detail}` : "…"}
        </span>
        {more > 0 && (
          <span className="mt-1 block">
            …and {more} more {more === 1 ? "conversation" : "conversations"} catching up in the
            background.
          </span>
        )}
      </PopoverContent>
    </Popover>
  );
}

import { Shield } from "lucide-react";

import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { useTimeTravelers } from "@/concord/hooks/useTimeTravelers";
import type { FoldedControl } from "@/concord/lib/control";
import type { Channel, Community } from "@/concord/lib/types";
import { cn } from "@/lib/utils";

/**
 * The sidebar alert for the control-plane watchdog + the playful time-traveler
 * flag. It only decides whether there is anything worth showing and, if so,
 * renders the entry button; the detail lives in the `suspicious` PANE
 * ({@link SuspiciousActivityView}), which `onOpen` navigates to. Sits above the
 * community's nav rows.
 */
export function SuspiciousActivityBanner({
  community,
  channels,
  folded,
  onOpen,
}: {
  community: Community | undefined;
  channels: Channel[];
  folded: FoldedControl | undefined;
  onOpen: () => void;
}) {
  const { actors, alert } = useSuspiciousActivity(community, folded);
  const travelers = useTimeTravelers(community, channels);

  // The playful time-traveler flag opens the panel on its own: it is the one
  // signal here that can be present with no control-plane abuse behind it.
  if (!alert && travelers.length === 0) return null;
  const count = actors.length + travelers.length;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2 pl-3 pr-2 py-1.5 touch:py-3 text-sm transition-colors text-left clip-corner-lg",
        "bg-destructive/15 text-destructive font-semibold hover:bg-destructive/25",
      )}
    >
      <Shield className="size-4 shrink-0" />
      <span className="truncate flex-1 min-w-0">Suspicious Activity</span>
      {count > 1 ? (
        <span className="shrink-0 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold leading-none">
          {count}
        </span>
      ) : null}
    </button>
  );
}

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PillTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

/**
 * The app's tab strip: cut-corner pills in a chrome vessel, first grown for
 * Discover and now shared with the community settings and moderation panes so
 * the three read as one idiom.
 *
 * Icon+label pills don't fit a 320px phone once there are more than a couple,
 * and truncating "Integrations" is worse than not showing it. So below `sm`
 * only the ACTIVE pill carries its label: it grows to fill the rail while the
 * others collapse to their icon. The label animates via a 0fr→1fr grid column,
 * which reaches its exact content width without any measuring or hardcoded
 * max-width (and merely snaps, rather than breaking, where that interpolation
 * is unsupported). A strip long enough to overflow anyway scrolls sideways
 * rather than squeezing its pills below a tap target.
 */
export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: readonly PillTab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-1 overflow-x-auto p-1 clip-corner-lg bg-chrome sm:w-auto sm:shrink-0",
        className,
      )}
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            aria-pressed={isActive}
            aria-label={t.label}
            className={cn(
              "flex items-center justify-center overflow-hidden px-2 py-1.5 text-sm clip-corner-lg transition-all duration-200 ease-out motion-reduce:transition-none touch:py-2.5 sm:flex-none sm:px-3",
              isActive
                ? "flex-1 bg-primary font-medium text-primary-foreground sm:flex-none"
                : "flex-none text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span
              className={cn(
                "grid transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none",
                isActive ? "grid-cols-[1fr]" : "grid-cols-[0fr] sm:grid-cols-[1fr]",
              )}
            >
              <span className="overflow-hidden whitespace-nowrap pl-1.5">{t.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PillTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

/**
 * Shared tab strip of cut-corner pills. Below `sm` only the active pill shows
 * its label, animated via a 0fr→1fr grid column (no measuring). Overflow scrolls.
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

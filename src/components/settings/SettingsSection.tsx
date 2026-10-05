import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Settings primitives: an uppercase group label over one cut-corner `bg-chrome` panel of hairline-divided rows. */

interface SettingsSectionProps {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({ title, icon: Icon, children, className }: SettingsSectionProps) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <h2 className="flex items-center gap-1.5 px-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {title}
      </h2>
      <div className="bg-chrome clip-corner-lg overflow-hidden [&>*]:border-chrome [&>*:not(:first-child)]:border-t">
        {children}
      </div>
    </section>
  );
}

interface SettingsRowProps {
  /** Row label (left). When omitted, `children` fills the whole row. */
  label?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  /** Stack a wide control below the label until `sm:`, so it doesn't crush the label column. */
  stack?: boolean;
  className?: string;
}

/** One flat settings row: labelled (label left, control right) or bare (`children` full-width). */
export function SettingsRow({ label, description, children, onClick, stack, className }: SettingsRowProps) {
  if (label === undefined) {
    return <div className={cn("px-4 py-3.5", className)}>{children}</div>;
  }
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full gap-3 px-4 py-3 text-left",
        stack ? "flex-col sm:flex-row sm:items-center" : "items-center",
        onClick && "transition-colors hover:bg-accent/40",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-sm font-medium leading-tight">{label}</div>
        {description && (
          <div className="text-xs text-muted-foreground leading-snug">{description}</div>
        )}
      </div>
      {children !== undefined && (
        <div className={cn(stack ? "w-full sm:w-auto sm:shrink-0" : "shrink-0")}>{children}</div>
      )}
    </Comp>
  );
}

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Discord/Ditto-style settings primitives matching Armada's "Corsair" chrome:
 * an uppercase muted group label over a single cut-corner `bg-chrome` panel of
 * flat, hairline-divided rows — not a stack of floating shadcn Cards.
 *
 *   <SettingsSection title="Voice" icon={Mic}>
 *     <SettingsRow label="Noise suppression">{switch}</SettingsRow>
 *     <SettingsRow>{customBlock}</SettingsRow>
 *   </SettingsSection>
 */

interface SettingsSectionProps {
  /** Uppercase group label rendered above the panel. */
  title: string;
  /** Leading icon for the group label. */
  icon: LucideIcon;
  /** Rows (and/or arbitrary content) inside the chrome panel. */
  children: ReactNode;
  className?: string;
}

/** A titled group of settings rows in a cut-corner chrome panel. */
export function SettingsSection({ title, icon: Icon, children, className }: SettingsSectionProps) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <h2 className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
  /** Secondary text under the label. */
  description?: ReactNode;
  /**
   * The control on the right (Switch, Button…). When `label` is omitted,
   * `children` is rendered full-width as the row body (e.g. an embedded editor).
   */
  children?: ReactNode;
  /** Make the whole row a clickable affordance (hover + cursor). */
  onClick?: () => void;
  /**
   * For a wide control (a button grid, an input) that would crush the label
   * column on a narrow screen: stack the control below the label until there
   * is room for a side-by-side row (`sm:`). The control then fills the row
   * width instead of sitting in the non-shrinking slot.
   */
  stack?: boolean;
  className?: string;
}

/**
 * One flat settings row. Two shapes:
 *   - labelled: label (+ optional description) left, `children` control right;
 *   - bare: pass only `children` to render arbitrary content full-width with
 *     the same row padding.
 *
 * A labelled row with a wide control (a button grid, a list editor) passes
 * `stack` so the control drops full-width below the label on a narrow screen
 * instead of crushing the label column in the non-shrinking slot, and rejoins
 * it side-by-side at `sm:`.
 */
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

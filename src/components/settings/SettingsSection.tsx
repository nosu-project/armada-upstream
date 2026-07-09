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
  className?: string;
}

/**
 * One flat settings row. Two shapes:
 *   - labelled: label (+ optional description) left, `children` control right;
 *   - bare: pass only `children` to render arbitrary content full-width with
 *     the same row padding.
 */
export function SettingsRow({ label, description, children, onClick, className }: SettingsRowProps) {
  if (label === undefined) {
    return <div className={cn("px-4 py-3.5", className)}>{children}</div>;
  }
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-3 text-left",
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
      {children !== undefined && <div className="shrink-0">{children}</div>}
    </Comp>
  );
}

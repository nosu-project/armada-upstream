import type { ReactNode } from "react";

import { ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { cn } from "@/lib/utils";

/**
 * Full-screen wizard chrome, shared by the signup wizard ({@link WelcomePage})
 * and the post-login setup flow ({@link LoginSetup}): background takeover, a
 * thin progress bar on top, and a centered, width-capped column that
 * fades/slides in per step.
 *
 * `stepKey` must differ between steps — it keys the column so React remounts it
 * and the enter animation replays. `index` (0-based) and `total` drive the
 * progress bar.
 */
export function WizardShell({
  index,
  total,
  stepKey,
  maxWidth = "max-w-sm",
  zClassName = "z-50",
  children,
}: {
  index: number;
  total: number;
  stepKey: string;
  /** Column width cap (a `max-w-*` class). Text-heavy steps go a size up. */
  maxWidth?: "max-w-sm" | "max-w-md" | "max-w-xl";
  /**
   * Stacking layer. Signup sits at `z-50` (nothing competes with it); the
   * post-login flow sits above Radix dialogs (`z-[250]`) so a queued invite
   * dialog can't paint over a setup step.
   */
  zClassName?: string;
  children: ReactNode;
}) {
  const pct = total > 0 ? ((index + 1) / total) * 100 : 100;
  return (
    <div className={cn("fixed inset-0 flex flex-col bg-background", zClassName)}>
      <div className="h-1 shrink-0 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        <div
          key={stepKey}
          className={cn(
            "mx-auto flex min-h-full w-full flex-col justify-center gap-8 px-6 py-12 safe-area-top safe-area-bottom",
            "animate-in fade-in slide-in-from-right-4 duration-300",
            maxWidth,
          )}
        >
          {children}
        </div>
      </div>
      <ArmadaCrestKeyframes />
    </div>
  );
}

/**
 * The common step body: a brand glyph, a lowercase mono heading, a muted
 * paragraph, then whatever actions the step needs. Kept here so every wizard
 * step — signup or post-login — reads the same.
 */
export function WizardStepBody({
  glyph,
  title,
  description,
  children,
}: {
  glyph: ReactNode;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      {glyph}
      <div className="space-y-2.5">
        <h1 className="font-mono text-2xl font-bold lowercase tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

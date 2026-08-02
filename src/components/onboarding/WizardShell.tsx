import { useEffect, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";

import { ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { AsciiSea } from "@/components/landing/AsciiSea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Full-screen wizard chrome, shared by the signup wizard ({@link WelcomePage})
 * and the post-login setup flow ({@link LoginSetup}): background takeover, a
 * thin progress bar on top, a back/close header, the landing's ASCII sea along
 * the bottom, and a centered, width-capped column that fades/slides in per
 * step.
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
  onBack,
  onClose,
  children,
}: {
  index: number;
  /** Number of steps in the flow. `0` means single-screen: no progress bar. */
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
  /** Step back. Omitted when there is nowhere to go back to. */
  onBack?: () => void;
  /** Leave the wizard entirely. Omitted when the flow can't be abandoned. */
  onClose?: () => void;
  children: ReactNode;
}) {
  // Escape closes, matching the dialog chrome this replaced. Only bound when
  // there's a close to run, so a flow that can't be abandoned stays put.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pct = total > 0 ? ((index + 1) / total) * 100 : 100;
  return (
    <div className={cn("fixed inset-0 flex flex-col bg-background", zClassName)}>
      {/*
        The landing's living background, at its resting waterline: a band of
        surf along the bottom of every step. Nothing scrolls it (no `scrollRef`)
        — the sea just breathes there while the wizard runs. Positioned, so
        every layer above it needs an explicit `relative z-*` to paint over it.
      */}
      <AsciiSea />

      {total > 0 && (
        <div className="relative z-10 h-1 shrink-0 bg-muted">
          <div
            className="h-full bg-primary transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* Back top-left, close top-right, on every step — the slots hold their
          width even when empty so the row never reflows between steps. */}
      <div className="relative z-20 flex shrink-0 items-center justify-between px-2 pt-2 safe-area-top">
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 touch:size-11 text-muted-foreground hover:text-foreground"
            onClick={onBack}
            aria-label="Back"
          >
            <ArrowLeft className="size-5" />
          </Button>
        ) : (
          <div className="size-9 touch:size-11" />
        )}
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 touch:size-11 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-5" />
          </Button>
        ) : (
          <div className="size-9 touch:size-11" />
        )}
      </div>

      {/*
        `scrollbar-gutter: stable` so the gutter is reserved whether or not a
        scrollbar is showing. Without it, a step that grows past the viewport
        (opening the profile editor's More section) takes ~15px of width away
        from the centered column mid-animation, and the whole step slides
        sideways while the section expands.
      */}
      <div className="relative z-10 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          key={stepKey}
          className={cn(
            "mx-auto flex min-h-full w-full flex-col justify-center gap-8 px-6 pb-12 pt-6 safe-area-bottom",
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

import { Check, Sparkles } from "lucide-react";
import { useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

interface AccountStandingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A joke rendition of Discord's "Account Standing" page. The meter is pegged
 * past its last milestone and visibly snapped, because there is no other state
 * it could report: no score, no strikes, and no account for anyone to revoke.
 */
export function AccountStandingDialog({ open, onOpenChange }: AccountStandingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title="Account standing"
        contentClassName="overflow-hidden text-center"
        // Land focus on the dialog itself: the punchline is its first
        // focusable element, and focusing it would open the explanation
        // before the joke has been read.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <div className="relative flex flex-col items-center">
          {/* The boot-splash crest, redrawing itself each time this opens. */}
          <ArmadaCrest size={104} />
          <ArmadaCrestKeyframes />

          {/* The green halo belongs to the verdict, not the mark — it sits
              behind the wordmark so the crest keeps its own brand colour. */}
          <div className="relative mt-4 w-full">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -inset-y-4 m-auto size-48 rounded-full bg-emerald-500/25 blur-3xl animate-[armada-epic-halo_0.9s_ease-in-out_infinite]"
            />
            <p className="relative text-[11px] font-semibold uppercase tracking-[0.35em] text-muted-foreground">
              Your account is
            </p>
            <p className="relative text-[clamp(3rem,26cqw,5rem)] font-black leading-none tracking-tight text-emerald-400 animate-[armada-epic-pulse_0.9s_ease-in-out_infinite]">
              EPIC
            </p>
            <EpicPulseKeyframes />
          </div>

          <StandingMeter />

          <p className="mt-6 text-sm font-medium leading-snug text-muted-foreground">
            <Punchline />
          </p>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}

/**
 * The punchline, with the plain reading behind it for anyone who takes the
 * joke literally — read as "we can't ban you *because* you're EPIC". A tooltip
 * so the joke itself stays untouched, and one a tap toggles, because Radix
 * tooltips open on hover and focus only, which is no one on a phone.
 */
function Punchline() {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-help underline decoration-muted-foreground/40 decoration-dotted underline-offset-4 touch:-my-3 touch:py-3"
          // Radix closes an open tooltip on trigger pointerdown and click, and
          // opens it on focus — which a tap also delivers. The click is the
          // toggle here (Enter/Space included), so none of them may reach it.
          onPointerDown={(e) => e.preventDefault()}
          onFocus={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            setOpen((o) => !o);
          }}
        >
          No score. No strikes. We can't ban you.
        </button>
      </TooltipTrigger>
      {/* Above the dialog (z-[250]), which the default tooltip layer is not. */}
      <TooltipContent className="z-[260] max-w-64 text-left text-xs leading-snug">
        There's no Armada account to ban: your identity is a key only you hold. A community can remove you
        from itself, but nobody can remove you from Armada.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The verdict's heartbeat: the wordmark swells and its halo flares with it.
 *
 * Scoped here rather than in tailwind.config because nothing else wants a
 * throb this loud. The `armada-` prefix is load-bearing —
 * {@link ArmadaCrestKeyframes}, already rendered above, kills every
 * `animate-[armada-…]` class under `prefers-reduced-motion`, so this opts into
 * that guard for free.
 */
function EpicPulseKeyframes() {
  return (
    <style>{`
      @keyframes armada-epic-pulse {
        0%, 100% {
          transform: scale(1);
          text-shadow: 0 0 24px rgba(16, 185, 129, 0.45);
        }
        50% {
          transform: scale(1.1);
          text-shadow:
            0 0 20px rgba(16, 185, 129, 0.9),
            0 0 70px rgba(16, 185, 129, 0.75);
        }
      }
      /* Transform + opacity only: the blur is rasterized once and the flare
         rides the compositor. */
      @keyframes armada-epic-halo {
        0%, 100% { transform: scale(0.9); opacity: 0.55; }
        50%      { transform: scale(1.25); opacity: 1; }
      }
    `}</style>
  );
}

/**
 * Every segment green, every milestone reached, and the track fractured near
 * the end where the last node tore loose and blew off the side of the card.
 */
function StandingMeter() {
  return (
    <div className="mt-8 w-full select-none">
      {/* Bleeds past the card's padding so the blown-out end is clipped by the
          dialog's chrome rather than tidily contained. */}
      <div className="relative -mr-9 flex items-center pr-8 sm:-mr-11">
        <Node>
          <Check className="size-4" strokeWidth={3} />
        </Node>
        <Track />
        <Node>
          <Check className="size-4" strokeWidth={3} />
        </Node>
        <Track />
        <Node>
          <Check className="size-4" strokeWidth={3} />
        </Node>
        <Track />
        <Node>
          <Check className="size-4" strokeWidth={3} />
        </Node>
        <BrokenTrack />
        <Node className="size-10 -translate-y-2 rotate-12 shadow-[0_0_28px_rgba(16,185,129,0.9)]">
          <Sparkles className="size-5" />
        </Node>
        {/* The fill kept going past the last milestone and off the card. */}
        <span
          aria-hidden
          className="absolute inset-y-0 -right-6 my-auto h-1.5 w-16 -translate-y-2 rotate-12 bg-gradient-to-r from-emerald-500 to-emerald-500/50"
        />
      </div>

      <div className="-mr-9 mt-2.5 flex items-baseline justify-between pr-8 text-[10px] font-bold uppercase tracking-wider text-emerald-400/70 sm:-mr-11">
        <span>All good!</span>
        <span className="text-emerald-400">Off the charts</span>
      </div>
    </div>
  );
}

/** A reached milestone. There is no unreached variant. */
function Node({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-black shadow-[0_0_16px_rgba(16,185,129,0.6)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A filled segment between two milestones. */
function Track() {
  return <span aria-hidden className="h-1.5 flex-1 bg-emerald-500" />;
}

/** The segment that gave out: snapped in two, with shards. */
function BrokenTrack() {
  return (
    <span aria-hidden className="relative h-1.5 flex-1">
      <span className="absolute inset-y-0 left-0 w-[52%] bg-emerald-500 [clip-path:polygon(0_0,100%_0,78%_100%,0_100%)]" />
      <span className="absolute inset-y-0 right-0 w-[40%] -translate-y-1 rotate-[9deg] bg-emerald-500 [clip-path:polygon(20%_0,100%_0,100%_100%,0_100%)]" />
      <span className="absolute -top-3 left-[56%] size-1.5 rotate-45 bg-emerald-400" />
      <span className="absolute -bottom-3 left-[62%] size-1 rotate-12 bg-emerald-400/80" />
      <span className="absolute -top-5 left-[68%] size-1 -rotate-12 bg-emerald-400/70" />
      <span className="absolute -bottom-5 left-[74%] size-[3px] bg-emerald-400/50" />
    </span>
  );
}

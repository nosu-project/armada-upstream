import { Hand, Smile } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCallSignals } from "@/contexts/CallSignalsContext";
import { cn } from "@/lib/utils";

/**
 * The quick emoji tray, à la Zoom/Signal in-call reactions. A small fixed set —
 * a floating burst is a glance, not a message, so a full picker would be
 * overkill (and reactions ride a size-bounded presence tag; see voice.ts).
 */
const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "👏"] as const;

/**
 * The in-call "Reactions" button: one entry point (à la Zoom's reactions tray)
 * for raising/lowering your hand and firing a transient emoji. Renders nothing
 * outside a Concord call, where the feature isn't available (`useCallSignals`
 * is disabled) — so the NIP-29/DM control bars simply omit it.
 *
 * `floating` switches the trigger to the compact bare-button styling the
 * floating window's control row uses; otherwise it matches the VoiceBar's
 * outline icon buttons.
 */
export function ReactionsMenu({
  className,
  floating = false,
}: {
  className?: string;
  floating?: boolean;
}) {
  const { enabled, myHandRaised, toggleHand, sendReaction } = useCallSignals();
  const [open, setOpen] = useState(false);

  if (!enabled) return null;

  const trigger = floating ? (
    <button
      type="button"
      aria-label="Reactions"
      title="Reactions"
      className={cn(
        "inline-flex items-center justify-center rounded-md size-8 shrink-0",
        myHandRaised
          ? "bg-amber-500/20 text-amber-500 hover:bg-amber-500/30"
          : "bg-foreground/10 text-foreground hover:bg-foreground/20",
        className,
      )}
    >
      {myHandRaised ? <Hand className="size-4" /> : <Smile className="size-4" />}
    </button>
  ) : (
    <Button
      variant={myHandRaised ? "default" : "outline"}
      size="icon"
      aria-label="Reactions"
      aria-pressed={myHandRaised}
      className={cn(
        "size-9 touch:size-11 shrink-0",
        myHandRaised && "bg-amber-500 text-white hover:bg-amber-500/90",
        className,
      )}
    >
      {myHandRaised ? <Hand className="size-4" /> : <Smile className="size-4" />}
    </Button>
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Reactions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-auto p-2">
        <button
          type="button"
          onClick={() => {
            toggleHand();
            setOpen(false);
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 touch:py-2.5 text-sm",
            myHandRaised
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25"
              : "hover:bg-foreground/10",
          )}
        >
          <Hand className="size-4 shrink-0" />
          {myHandRaised ? "Lower hand" : "Raise hand"}
        </button>
        <div className="mt-1.5 grid grid-cols-4 gap-1">
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => {
                sendReaction(emoji);
                setOpen(false);
              }}
              className="flex size-10 touch:size-12 items-center justify-center rounded-md font-emoji text-2xl leading-none hover:bg-foreground/10 active:scale-95 transition-transform"
            >
              {emoji}
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

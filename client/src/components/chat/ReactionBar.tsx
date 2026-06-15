import { SmilePlus } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { cn } from "@/lib/utils";

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/** Lazy-loaded EmojiPicker — keeps emoji-mart + its data out of the main bundle. */
const LazyEmojiPicker = lazy(() =>
  import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);

interface ReactionBarProps {
  tallies: ReactionTally[];
  /** Whether the current user may toggle reactions (group membership). */
  canReact: boolean;
  onReact: (input: ReactInput) => void;
}

/**
 * Renders the NIP-25 reaction tally pills beneath a message. Clicking a pill
 * toggles the current user's own reaction with that emoji on/off.
 */
export function ReactionBar({ tallies, canReact, onReact }: ReactionBarProps) {
  if (tallies.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {tallies.map((tally) => {
        const isCustom = tally.url && tally.key.startsWith(":") && tally.key.endsWith(":");
        return (
          <button
            key={tally.key}
            type="button"
            disabled={!canReact}
            onClick={() =>
              canReact &&
              onReact({
                key: tally.key,
                content: tally.key === "👍" ? "+" : tally.key,
                emojiUrl: tally.url,
              })
            }
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-none transition-colors",
              tally.mine
                ? "border-primary bg-primary/15 text-primary"
                : "border-border/60 bg-secondary/40 text-foreground hover:border-foreground/30",
              !canReact && "cursor-default opacity-80",
            )}
          >
            {isCustom
              ? <CustomEmojiImg name={tally.key.slice(1, -1)} url={tally.url!} className="inline h-4 w-4 object-contain" />
              : <span className="text-sm leading-none">{tally.key}</span>}
            <span className="tabular-nums">{tally.count}</span>
          </button>
        );
      })}
    </div>
  );
}

interface ReactionPickerProps {
  onReact: (input: ReactInput) => void;
}

/**
 * The "add reaction" trigger for a message's hover/tap action menu. Opens an
 * emoji picker popover (native + NIP-30 custom emoji) and publishes the
 * selected reaction.
 */
export function ReactionPicker({ onReact }: ReactionPickerProps) {
  const { emojis: customEmojis } = useCustomEmojis();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Add reaction"
              className="size-7 text-muted-foreground hover:text-primary"
            >
              <SmilePlus className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Add reaction</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[min(20rem,90vw)] p-0 rounded-xl border-border shadow-lg overflow-hidden"
      >
        <Suspense fallback={<div className="h-[360px]" />}>
          <LazyEmojiPicker
            customEmojis={customEmojis}
            onSelect={(selection) => {
              if (selection.type === "native") {
                onReact({ key: selection.emoji, content: selection.emoji });
              } else {
                onReact({
                  key: `:${selection.shortcode}:`,
                  content: `:${selection.shortcode}:`,
                  emojiUrl: selection.url,
                });
              }
              setOpen(false);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

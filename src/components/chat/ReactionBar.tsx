import { SmilePlus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { EmojiSourceFooter } from "@/components/chat/EmojiSourceFooter";
import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { recordReaction, useFrequentReactions } from "@/hooks/useFrequentReactions";
import { useIsTouch } from "@/hooks/useIsMobile";
import { getAvatarShape } from "@/lib/avatarShape";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { isRenderableReactionKey } from "@/lib/customEmoji";
import { QUICK_SLOTS_POINTER, toggleInput } from "@/lib/reactionToggle";
import { cn } from "@/lib/utils";

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/** Lazy-loaded EmojiPicker — keeps emoji-mart + its data out of the main bundle. */
const LazyEmojiPicker = lazy(() =>
  import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);

/** Hover dwell before a pill's detail popover opens, and the grace on leave. */
const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 120;

/** Press-and-hold duration that opens the detail popover on touch. */
const LONG_PRESS_MS = 450;

/** How far a finger may drift during a hold before it counts as a scroll. */
const LONG_PRESS_SLOP_PX = 10;

/** Renders the visual content of a reaction key (custom image or emoji glyph). */
export function ReactionGlyph({
  emojiKey,
  url,
  className,
}: {
  emojiKey: string;
  url?: string;
  className?: string;
}) {
  // What to show when there's no (working) image: the key if it's a short,
  // renderable glyph or a `:shortcode:`, otherwise a neutral placeholder so a
  // junk key (e.g. a raw URL pasted as the reaction content) never renders as a
  // long line of text.
  const shortcode = emojiKey.startsWith(":") && emojiKey.endsWith(":");
  const label = isRenderableReactionKey(emojiKey) || shortcode ? emojiKey : "❓";
  const glyphText = (
    <span className={cn("inline-flex items-center justify-center leading-none -translate-y-px", className ?? "text-base")}>
      {label}
    </span>
  );
  if (url) {
    return (
      <CustomEmojiImg
        name={shortcode ? emojiKey.slice(1, -1) : emojiKey}
        url={url}
        className={cn("inline object-contain", className ?? "h-5 w-5")}
        fallback={glyphText}
      />
    );
  }
  return glyphText;
}

/** A single reactor row (avatar + display name) inside the detail popover. */
function ReactorRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(pubkey, metadata);
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-[9px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="text-xs truncate">
        <DisplayName pubkey={pubkey} name={displayName} />
      </span>
    </div>
  );
}

/** The pill's detail popover: who reacted, and where the emoji came from. */
function ReactionDetail({ tally }: { tally: ReactionTally }) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ReactionGlyph emojiKey={tally.key} url={tally.url} className="h-6 w-6 text-xl" />
        <span className="text-xs text-muted-foreground">
          {tally.count} {tally.count === 1 ? "reaction" : "reactions"}
        </span>
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        {tally.pubkeys.map((pubkey) => (
          <ReactorRow key={pubkey} pubkey={pubkey} />
        ))}
      </div>
      {tally.url && <EmojiSourceFooter url={tally.url} authorPubkey={tally.pubkeys[0]} />}
    </>
  );
}

/**
 * A reaction pill.
 *
 * Click TOGGLES the reaction — the one-click path every other chat client has.
 * The reactor list is supplementary: it opens on hover (pointer devices, after
 * a short dwell so scrubbing across a row doesn't flash popovers) or on
 * press-and-hold (touch), and is where a custom emoji's source pack is named.
 */
function ReactionPill({
  tally,
  canReact,
  onReact,
}: {
  tally: ReactionTally;
  canReact: boolean;
  onReact: (input: ReactInput) => void;
}) {
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const [open, setOpen] = useState(false);

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  // Set when a long-press opened the popover, so the click that ends the press
  // doesn't also toggle the reaction.
  const longPressed = useRef(false);
  // How the popover was opened. A keyboard-opened one hands focus to its
  // content (so the "Add pack" button is reachable at all); a hover- or
  // press-opened one must not steal focus.
  const openReason = useRef<"hover" | "press" | "focus">("hover");

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = null;
  };

  const scheduleOpen = () => {
    clearTimer(closeTimer);
    clearTimer(openTimer);
    openTimer.current = setTimeout(() => {
      openReason.current = "hover";
      setOpen(true);
    }, HOVER_OPEN_MS);
  };
  const scheduleClose = () => {
    clearTimer(openTimer);
    clearTimer(closeTimer);
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };

  // A row can unmount mid-gesture (the timeline virtualises and reactions
  // stream in), so pending timers must not outlive it.
  useEffect(
    () => () => {
      for (const ref of [openTimer, closeTimer, pressTimer]) {
        if (ref.current) clearTimeout(ref.current);
      }
    },
    [],
  );

  const toggle = () => {
    if (!canReact) return;
    const input = toggleInput(tally.key, tally.url, [tally]);
    if (!input.mineEventId) recordReaction(user?.pubkey, input.key, input.emojiUrl);
    onReact(input);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/*
        ANCHOR, not Trigger: the pill's click is the reaction toggle, and
        Trigger would additionally open the popover on every click. The detail
        view is opened deliberately (hover dwell, long-press, keyboard focus),
        so this component owns `open` outright.
      */}
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-pressed={tally.mine}
          aria-label={`${tally.key}, ${tally.count} ${tally.count === 1 ? "reaction" : "reactions"}`}
          className={cn(
            // `select-none` + `[-webkit-touch-callout:none]` + descendant
            // `pointer-events-none` keep the button itself the pointer target: a
            // long-press landing on the nested emoji glyph/image would otherwise
            // trigger the browser's native text-selection / image-drag gesture,
            // which fires `pointercancel` and clears the long-press timer before
            // the popover opens.
            "select-none [-webkit-touch-callout:none] [&_*]:pointer-events-none",
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 touch:px-3.5 touch:py-2.5 text-sm leading-none transition-colors",
            tally.mine
              ? "border-primary bg-primary/15 text-primary"
              : "border-border/60 bg-secondary/40 text-foreground hover:border-foreground/40 hover:bg-secondary/70",
            !canReact && "cursor-default",
          )}
          onClick={() => {
            if (longPressed.current) {
              longPressed.current = false;
              return;
            }
            toggle();
          }}
          onPointerEnter={(e) => {
            if (isTouch || e.pointerType === "touch") return;
            scheduleOpen();
          }}
          onPointerLeave={(e) => {
            if (isTouch || e.pointerType === "touch") return;
            scheduleClose();
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== "touch") return;
            // Own the press: the row is wrapped in a ContextMenu whose trigger
            // arms its own long-press on touch, and swipe-to-reply listens on
            // the row. Both would fight this gesture.
            e.stopPropagation();
            longPressed.current = false;
            pressOrigin.current = { x: e.clientX, y: e.clientY };
            clearTimer(pressTimer);
            pressTimer.current = setTimeout(() => {
              longPressed.current = true;
              openReason.current = "press";
              setOpen(true);
            }, LONG_PRESS_MS);
          }}
          onPointerUp={() => clearTimer(pressTimer)}
          onPointerCancel={() => clearTimer(pressTimer)}
          onPointerMove={(e) => {
            // Only a real drag (a scroll starting on the pill) cancels the
            // hold — a finger never rests perfectly still, so cancelling on any
            // movement at all would make long-press fail most of the time.
            if (e.pointerType !== "touch" || !pressTimer.current) return;
            const origin = pressOrigin.current;
            if (!origin) return;
            if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > LONG_PRESS_SLOP_PX) {
              clearTimer(pressTimer);
            }
          }}
          onFocus={(e) => {
            // Keyboard focus reveals the detail the way hover does; a focus that
            // merely follows a click does not.
            try {
              if (!e.currentTarget.matches(":focus-visible")) return;
            } catch {
              return; // :focus-visible unsupported — skip the keyboard affordance
            }
            openReason.current = "focus";
            setOpen(true);
          }}
          onBlur={() => {
            // A keyboard-opened popover takes focus itself, so blurring the pill
            // is expected — Radix closes it on focus/interaction outside.
            if (openReason.current !== "focus") setOpen(false);
          }}
        >
          <ReactionGlyph emojiKey={tally.key} url={tally.url} className="h-5 w-5 text-base" />
          <span className="tabular-nums font-medium">{tally.count}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        // Hover- and press-opened content must not steal focus (it would scroll
        // the timeline and trap the caret away from the composer).
        onOpenAutoFocus={(e) => {
          if (openReason.current !== "focus") e.preventDefault();
        }}
        onPointerEnter={() => clearTimer(closeTimer)}
        onPointerLeave={() => {
          if (!isTouch) scheduleClose();
        }}
        className="w-56 p-0 rounded-xl border-border shadow-lg overflow-hidden"
      >
        <ReactionDetail tally={tally} />
      </PopoverContent>
    </Popover>
  );
}

interface ReactionBarProps {
  tallies: ReactionTally[];
  /** Whether the current user may toggle reactions (group membership). */
  canReact: boolean;
  onReact: (input: ReactInput) => void;
  /**
   * Optional node rendered first in the pill row (the zap total chip), so it
   * sits inline with the reaction pills instead of on its own line.
   */
  leading?: React.ReactNode;
}

/**
 * Renders the NIP-25 reaction tally pills beneath a message. Clicking a pill
 * adds or removes the current user's reaction; hover (or press-and-hold)
 * reveals who reacted.
 */
export function ReactionBar({ tallies, canReact, onReact, leading }: ReactionBarProps) {
  if (tallies.length === 0 && !leading) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 touch:gap-2 mt-1.5">
      {leading}
      {tallies.map((tally) => (
        <ReactionPill key={tally.key} tally={tally} canReact={canReact} onReact={onReact} />
      ))}
    </div>
  );
}

interface ReactionActionsProps {
  onReact: (input: ReactInput) => void;
  /**
   * The message's current tallies, so a quick button or a picker selection
   * that repeats an existing reaction retracts it instead of republishing it.
   */
  tallies?: ReactionTally[];
  /**
   * How many one-click quick reactions to show before the picker button. Pass
   * 0 in cramped surfaces (the thread panel) to render just the picker.
   */
  quickSlots?: number;
}

const NO_TALLIES: ReactionTally[] = [];

/**
 * The reaction controls on a message's hover/tap action toolbar: a row of the
 * user's most-used emoji for one-click reacting, then the full picker.
 *
 * The quick row is the point — reacting is overwhelmingly a repeat of
 * something you've reacted with before, and routing every one of those through
 * a picker popover is the slow path.
 */
export function ReactionActions({
  onReact,
  tallies = NO_TALLIES,
  quickSlots = QUICK_SLOTS_POINTER,
}: ReactionActionsProps) {
  const { emojis: customEmojis } = useCustomEmojis();
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);

  const frequent = useFrequentReactions(user?.pubkey, quickSlots);

  const react = useCallback(
    (key: string, url?: string) => {
      const input = toggleInput(key, url, tallies);
      if (!input.mineEventId) recordReaction(user?.pubkey, input.key, input.emojiUrl);
      onReact(input);
    },
    [onReact, tallies, user?.pubkey],
  );

  return (
    <>
      {frequent.map((f) => {
        const mine = tallies.find((t) => t.key === f.key)?.mine ?? false;
        return (
          <Tooltip key={f.key}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={mine ? `Remove ${f.key} reaction` : `React with ${f.key}`}
                aria-pressed={mine}
                className={cn(
                  "size-9 md:size-7 touch:size-11 touch:md:size-11",
                  mine ? "text-primary bg-primary/10" : "hover:bg-secondary",
                )}
                onClick={() => react(f.key, f.url)}
              >
                <ReactionGlyph
                  emojiKey={f.key}
                  url={f.url}
                  className="h-[18px] w-[18px] md:h-4 md:w-4 text-base md:text-sm"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{mine ? `Remove ${f.key}` : f.key}</TooltipContent>
          </Tooltip>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Add reaction"
                className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-primary"
              >
                <SmilePlus className="size-[18px] md:size-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Add reaction</TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className="flex w-[min(20rem,90vw)] h-[min(360px,55dvh)] max-h-[var(--radix-popover-content-available-height)] p-0 rounded-xl border-border shadow-lg overflow-hidden"
        >
          <Suspense fallback={<div className="w-full" />}>
            <LazyEmojiPicker
              customEmojis={customEmojis}
              onSelect={(selection) => {
                if (selection.type === "native") {
                  react(selection.emoji);
                } else {
                  react(`:${selection.shortcode}:`, selection.url);
                }
                setOpen(false);
              }}
            />
          </Suspense>
        </PopoverContent>
      </Popover>
    </>
  );
}

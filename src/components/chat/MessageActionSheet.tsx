import { SmilePlus } from "lucide-react";
import { lazy, Suspense, useCallback, useRef, useState } from "react";

import { ReactionGlyph } from "@/components/chat/ReactionBar";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { recordReaction, useFrequentReactions } from "@/hooks/useFrequentReactions";
import { QUICK_SLOTS_SHEET, toggleInput } from "@/lib/reactionToggle";
import { cn } from "@/lib/utils";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/**
 * How long after opening to refuse an "outside interaction" dismiss. On touch
 * the very press that opens the sheet leaves a trailing pointer/synthetic event
 * the dismissable layer reads as an outside tap; refusing it HERE (rather than
 * in the parent's `onOpenChange`) keeps vaul from ever committing that close,
 * so the controlled `open` prop can't desync and wedge the sheet shut.
 */
const OPEN_GUARD_MS = 400;

const LazyEmojiPicker = lazy(() =>
  import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);

interface MessageActionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: MessageActionItem[];
  /** Omitted when the user can't react (no membership / message is pending). */
  reactions?: {
    tallies: ReactionTally[];
    react: (input: ReactInput) => void;
  };
}

/**
 * The touch-device message menu: a bottom sheet with a row of quick reactions
 * over a vertical list of actions.
 *
 * This replaces the floating hover toolbar on touch rather than supplementing
 * it. That strip is a pointer idiom — it has to fit every capability a message
 * offers into one horizontal line at the row's edge, which on a phone means
 * eight 44px targets competing for ~360px and wrapping over the message text.
 * A sheet gives each action a full-width labelled row (much harder to
 * mis-tap, which is what the old two-step tap-to-reveal was defending against)
 * and gives the emoji row a line of its own.
 */
export function MessageActionSheet({
  open,
  onOpenChange,
  actions,
  reactions,
}: MessageActionSheetProps) {
  // The picker takes over the sheet rather than opening a nested overlay on
  // top of it — same as Discord's sheet expanding into the full picker.
  const [pickerOpen, setPickerOpen] = useState(false);
  const { user } = useCurrentUser();
  const { emojis: customEmojis } = useCustomEmojis();
  const frequent = useFrequentReactions(user?.pubkey, QUICK_SLOTS_SHEET);

  // Android back closes the sheet, and only the sheet — a second back leaves
  // the chat, the same one-surface-per-back the thread panel and lightboxes
  // follow. Without an entry of its own, SwipeReveal's handler would win and
  // slide the chat pane away with the menu still up: the pane is translated,
  // never unmounted, and the drawer portals to <body>, so nothing else takes
  // the menu down. Registered only while open, so it sits above SwipeReveal's
  // handler for exactly as long as the sheet is on screen.
  useAndroidBack(() => {
    onOpenChange(false);
    return true;
  }, open);

  // When the sheet last opened, to reject the dismiss the opening gesture
  // itself provokes (see OPEN_GUARD_MS).
  const openedAt = useRef(0);

  // Stamped during the render that opens the sheet, NOT in an effect. A passive
  // effect runs after commit, by which point the dismissable layer is already
  // listening — and the stale value it would race against is the PREVIOUS
  // open's, seconds old, so the guard wouldn't merely be missing, it would read
  // as long expired and wave the dismiss through. That is the reopen-right-
  // after-dismiss case: the sheet opens and is shut again before it is seen.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) openedAt.current = Date.now();
    // Always reopen on the actions page, never on whatever page the last
    // message was left on.
    else setPickerOpen(false);
  }

  const react = useCallback(
    (key: string, url?: string) => {
      if (!reactions) return;
      const input = toggleInput(key, url, reactions.tallies);
      if (!input.mineEventId) recordReaction(user?.pubkey, input.key, input.emojiUrl);
      reactions.react(input);
      onOpenChange(false);
    },
    [reactions, user?.pubkey, onOpenChange],
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[85dvh]"
        // Refuse the opening gesture's own trailing event; a genuine dismiss
        // arrives later. Prevented here, vaul never closes, so `open` stays in
        // sync and a later long-press can reopen (a stale close would leave the
        // row highlighted with no menu).
        onPointerDownOutside={(e) => {
          if (Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault();
        }}
      >
        <DrawerTitle className="sr-only">Message actions</DrawerTitle>

        {pickerOpen ? (
          <div className="flex w-full flex-col pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <Suspense fallback={<div className="w-full" />}>
              <LazyEmojiPicker
                customEmojis={customEmojis}
                onSelect={(selection) => {
                  if (selection.type === "native") react(selection.emoji);
                  else react(`:${selection.shortcode}:`, selection.url);
                }}
              />
            </Suspense>
          </div>
        ) : (
          <div className="overflow-y-auto overscroll-contain pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {reactions && (
              <div className="flex items-center gap-2 px-3 pb-2">
                {/* The quick slots read as one control (a pill of emoji), with
                    "more" as its own button — the same split Discord uses. */}
                <div className="flex flex-1 items-center gap-0.5 rounded-full bg-muted/60 p-1">
                  {frequent.map((f) => {
                    const mine = reactions.tallies.find((t) => t.key === f.key)?.mine ?? false;
                    return (
                      <button
                        key={f.key}
                        type="button"
                        aria-label={mine ? `Remove ${f.key} reaction` : `React with ${f.key}`}
                        aria-pressed={mine}
                        className={cn(
                          "flex size-11 flex-1 items-center justify-center rounded-full transition-colors",
                          mine ? "bg-primary/20 ring-1 ring-primary" : "active:bg-background",
                        )}
                        onClick={() => react(f.key, f.url)}
                      >
                        <ReactionGlyph
                          emojiKey={f.key}
                          url={f.url}
                          className="size-7 text-2xl"
                        />
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  aria-label="Add reaction"
                  className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground active:bg-secondary"
                  onClick={() => setPickerOpen(true)}
                >
                  <SmilePlus className="size-6" />
                </button>
              </div>
            )}

            <div className="px-2 pb-1">
              {actions.map((action) => (
                <div key={action.id}>
                  {action.groupStart && <div className="mx-3 my-1.5 h-px bg-border/60" />}
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-left text-[15px] font-medium active:bg-secondary",
                      action.destructive ? "text-destructive" : "text-foreground",
                    )}
                    onClick={() => {
                      onOpenChange(false);
                      action.onSelect();
                    }}
                  >
                    <action.icon
                      className={cn(
                        "size-5 shrink-0",
                        !action.destructive && "text-muted-foreground",
                      )}
                    />
                    {action.label}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

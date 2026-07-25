import { SmilePlus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { ReactionGlyph } from "@/components/chat/ReactionBar";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { recordReaction, useFrequentReactions } from "@/hooks/useFrequentReactions";
import { QUICK_SLOTS_SHEET, toggleInput } from "@/lib/reactionToggle";
import { cn } from "@/lib/utils";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

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

  // Always reopen on the actions page, never on whatever page the last message
  // was left on.
  useEffect(() => {
    if (!open) setPickerOpen(false);
  }, [open]);

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
      <DrawerContent className="max-h-[85dvh]">
        <DrawerTitle className="sr-only">Message actions</DrawerTitle>

        {pickerOpen ? (
          <div className="flex h-[60dvh] w-full flex-col pt-2">
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

import { SmilePlus } from "lucide-react";
import { createPortal } from "react-dom";

import { ReactionGlyph, ReactionPickerPanel, REACTION_PICKER_CLASS, useToggleReact } from "@/components/chat/ReactionBar";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useQuickReactions } from "@/hooks/useQuickReactionList";
import { QUICK_SLOTS_MENU } from "@/lib/reactionToggle";
import { cn } from "@/lib/utils";

import type { MessageReactions } from "@/components/chat/transport";

/** The right-click menu's top row: the most-used reactions, then the full picker. */
export function MenuReactionRow({
  reactions,
  onOpenPicker,
}: {
  reactions: MessageReactions;
  onOpenPicker: () => void;
}) {
  const { user } = useCurrentUser();
  const frequent = useQuickReactions(user?.pubkey, QUICK_SLOTS_MENU);
  const react = useToggleReact(reactions.react, reactions.tallies);

  return (
    <>
      <div role="group" aria-label="Reactions" className="flex items-center justify-between gap-0.5">
        {frequent.map((f) => {
          const mine = reactions.tallies.find((t) => t.key === f.key)?.mine ?? false;
          return (
            <DropdownMenuItem
              key={f.key}
              aria-label={mine ? `Remove ${f.key} reaction` : `React with ${f.key}`}
              className={cn("size-8 justify-center p-0 touch:py-0", mine && "bg-primary/10 focus:bg-primary/20")}
              onSelect={() => react(f.key, f.url)}
            >
              <ReactionGlyph emojiKey={f.key} url={f.url} className="size-5 text-lg" />
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuItem
          aria-label="Add reaction"
          className="size-8 justify-center p-0 touch:py-0 text-muted-foreground"
          onSelect={onOpenPicker}
        >
          <SmilePlus className="size-4" />
        </DropdownMenuItem>
      </div>
      <DropdownMenuSeparator />
    </>
  );
}

/** The full picker, opened from {@link MenuReactionRow} where the menu stood. */
export function MenuReactionPicker({
  point,
  reactions,
  onClose,
}: {
  point: { x: number; y: number };
  reactions: MessageReactions;
  onClose: () => void;
}) {
  const react = useToggleReact(reactions.react, reactions.tallies);
  // Portalled like the menu, so the fixed anchor isn't caught by a transformed ancestor.
  return createPortal(
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{ position: "fixed", left: point.x, top: point.y, width: 0, height: 0, pointerEvents: "none" }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={2}
        className={REACTION_PICKER_CLASS}
        // The anchor is invisible; focus goes nowhere rather than to it.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <ReactionPickerPanel
          onBrowsePacks={onClose}
          onPick={(key, url) => {
            react(key, url, true);
            onClose();
          }}
        />
      </PopoverContent>
    </Popover>,
    document.body,
  );
}

import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { ReactionGlyph, ReactionPickerPanel, REACTION_PICKER_CLASS } from "@/components/chat/ReactionBar";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { quickReactionRow, useFrequentReactionTable, type QuickReactionSlot } from "@/hooks/useFrequentReactions";
import { usePublishQuickReactions, useQuickReactionList } from "@/hooks/useQuickReactionList";
import { toast } from "@/hooks/useToast";
import { MAX_QUICK_REACTIONS } from "@/lib/reactionToggle";
import {
  arrayMove,
  CSS,
  DndContext,
  horizontalListSortingStrategy,
  KeyboardSensor,
  PointerSensor,
  SortableContext,
  useSensor,
  useSensors,
  useSortable,
  type DragEndEvent,
} from "@/lib/sortable";
import { cn } from "@/lib/utils";

import type { QuickReaction } from "@/lib/quickReactions";

/**
 * The quick-reaction row as the action sheet shows it; shorter rows show its
 * first slots. Unpinned slots are filled from use, faded. Choosing an emoji for
 * any slot pins the whole row as shown, so what's on screen is what the menus
 * offer; removing one hands that slot back to use. Dragging reorders and pins.
 * Every change publishes the kind-10077 list, one at a time.
 */
export function QuickReactionsSettings() {
  const { user } = useCurrentUser();
  const list = useQuickReactionList();
  const publish = usePublishQuickReactions();
  const stored = useFrequentReactionTable(user?.pubkey);
  // Shown while its publish is in flight, so the row doesn't snap back meanwhile.
  const [pending, setPending] = useState<QuickReaction[] | null>(null);
  const pinned = pending ?? list.reactions;
  const slots = useMemo(() => quickReactionRow(stored, pinned, MAX_QUICK_REACTIONS), [stored, pinned]);
  // The publish checks the relays against the version this row was built from.
  const ready = list.isFetched && pending === null;

  const save = (next: QuickReaction[]) => {
    if (!ready) return;
    setPending(next);
    publish
      .mutateAsync({ reactions: next, basis: list.event?.id ?? null })
      .catch((e: unknown) => {
        toast({
          title: "Couldn't save quick reactions",
          description: e instanceof Error ? e.message : "Publishing failed.",
          variant: "destructive",
        });
      })
      .finally(() => setPending(null));
  };

  const row = useMemo(
    () => slots.map(({ key, url, set }): QuickReaction => (url ? (set ? { key, url, set } : { key, url }) : { key })),
    [slots],
  );
  const ids = useMemo(() => slots.map((s) => s.key), [slots]);

  // A move threshold, so a tap still opens the picker.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const from = ids.indexOf(active.id);
    const to = ids.indexOf(over.id);
    if (from === -1 || to === -1 || from === to) return;
    save(arrayMove(row, from, to));
  };

  /** Put `reaction` in slot `at` and pin the row, dropping it from any other slot. */
  const pick = (at: number, reaction: QuickReaction) => {
    const next = row.map((r, i) => (i === at ? reaction : r));
    save(next.filter((r, i) => i === at || r.key !== reaction.key).slice(0, MAX_QUICK_REACTIONS));
  };

  const unpin = (key: string) => save(pinned.filter((r) => r.key !== key));

  return (
    <SettingsRow className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium leading-tight">Quick reactions</div>
          <div className="text-xs text-muted-foreground leading-snug">
            The reactions offered on a message. Choose one to swap it, or drag to reorder.
          </div>
        </div>
        {pinned.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            disabled={!ready}
            onClick={() => save([])}
          >
            Reset
          </Button>
        )}
      </div>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <div className="flex gap-2">
            {slots.map((slot, i) => (
              <QuickReactionSlotButton
                key={slot.key}
                position={i + 1}
                slot={slot}
                disabled={!ready}
                onPick={(reaction) => pick(i, reaction)}
                onUnpin={() => unpin(slot.key)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {slots.some((s) => !s.pinned) && (
        <div className="text-xs text-muted-foreground leading-snug">
          Faded reactions fill in from the ones you use most, and change as you react.
        </div>
      )}
    </SettingsRow>
  );
}

function QuickReactionSlotButton({
  position,
  slot,
  disabled,
  onPick,
  onUnpin,
}: {
  position: number;
  slot: QuickReactionSlot;
  disabled: boolean;
  onPick: (reaction: QuickReaction) => void;
  onUnpin: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slot.key, disabled });
  const [open, setOpen] = useState(false);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group relative", isDragging && "z-10")}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={slot.pinned
              ? `Change quick reaction ${position}`
              : `Change quick reaction ${position}, filled in from your most used`}
            {...attributes}
            {...listeners}
            className={cn(
              "flex size-11 items-center justify-center rounded-full bg-secondary/50 hover:bg-secondary",
              // A plain pointer: a press is a tap until it moves. The grab hand only while dragging.
              isDragging ? "cursor-grabbing" : "cursor-pointer",
              "transition-[background-color,transform,box-shadow,opacity]",
              "disabled:cursor-default disabled:opacity-60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isDragging && "scale-110 shadow-lg",
            )}
          >
            <span className={cn("flex items-center justify-center", !slot.pinned && "opacity-40")}>
              <ReactionGlyph emojiKey={slot.key} url={slot.url} className="size-6 text-xl" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className={REACTION_PICKER_CLASS}>
          <ReactionPickerPanel
            recordUsage={false}
            onBrowsePacks={() => setOpen(false)}
            onPick={(key, url) => {
              setOpen(false);
              onPick(url ? { key, url } : { key });
            }}
          />
        </PopoverContent>
      </Popover>
      {slot.pinned && !isDragging && (
        <button
          type="button"
          disabled={disabled}
          onClick={onUnpin}
          aria-label={`Remove quick reaction ${position}`}
          className={cn(
            "absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-[color,opacity] hover:bg-background hover:text-destructive",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            // A bigger hit area than the badge, grown only up and out so it never covers the emoji.
            "after:absolute after:-right-2.5 after:-top-2.5 after:bottom-0 after:left-0 after:content-['']",
            // Always shown on touch; with a mouse, only while hovering or focused.
            "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
          )}
        >
          <X className="size-3.5" strokeWidth={3.5} />
        </button>
      )}
    </div>
  );
}

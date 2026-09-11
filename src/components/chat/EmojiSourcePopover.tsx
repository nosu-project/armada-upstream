import { useState } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { EmojiSourceFooter } from "@/components/chat/EmojiSourceFooter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface EmojiSourcePopoverProps {
  /** The shortcode name (without colons). */
  name: string;
  /** The image URL. */
  url: string;
  /** CSS class name forwarded to the inline emoji image. */
  imgClassName?: string;
  /** Who typed the message, for the author-scoped pack lookup on an unknown emoji. */
  authorPubkey?: string;
}

/**
 * An inline custom emoji that opens, on click, the same source popover a
 * reaction pill shows: a preview of the emoji plus which NIP-30 pack it came
 * from and a one-tap add. Seeing an emoji you like in a message is enough to
 * get its pack, without hunting for a reaction to inspect.
 *
 * The popover body reuses `EmojiSourceFooter`, which renders nothing when the
 * pack can't be resolved — so an unknown emoji still names its shortcode in the
 * header but offers no add.
 */
export function EmojiSourcePopover({ name, url, imgClassName, authorPubkey }: EmojiSourcePopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/*
          A bare inline button so the emoji keeps its place in the text flow;
          `stopPropagation` keeps the click from reaching the message row (which
          would open the thread / clear selection).
        */}
        <button
          type="button"
          aria-label={`:${name}: emoji`}
          className="inline cursor-pointer align-text-bottom"
          onClick={(e) => e.stopPropagation()}
        >
          <CustomEmojiImg name={name} url={url} className={imgClassName} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-56 p-0 rounded-xl border-border shadow-lg overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <CustomEmojiImg
            name={name}
            url={url}
            className={cn("inline object-contain", "h-8 w-8")}
          />
          <span className="truncate text-xs font-medium">:{name}:</span>
        </div>
        <EmojiSourceFooter url={url} authorPubkey={authorPubkey} />
      </PopoverContent>
    </Popover>
  );
}

import { useState } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { EmojiSourceFooter } from "@/components/chat/EmojiSourceFooter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface EmojiSourcePopoverProps {
  name: string;
  url: string;
  imgClassName?: string;
  /** Who typed the message, for the author-scoped pack lookup on an unknown emoji. */
  authorPubkey?: string;
}

/** Inline custom emoji that opens its source-pack popover (via `EmojiSourceFooter`). */
export function EmojiSourcePopover({ name, url, imgClassName, authorPubkey }: EmojiSourcePopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Inline button keeps text flow; stopPropagation keeps the row from reacting. */}
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

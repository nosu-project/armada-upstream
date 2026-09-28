import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { cn } from "@/lib/utils";

/**
 * Icon button to Discover's emoji packs. Kept out of `EmojiPicker` so importing
 * it doesn't pull emoji-mart into the main bundle.
 */
export function BrowseEmojiPacksButton({ onBrowse, className }: { onBrowse: () => void; className?: string }) {
  const navigate = useStableNavigate();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Browse emoji packs"
          className={cn("size-8 touch:size-11 shrink-0 rounded-full text-muted-foreground", className)}
          onClick={() => {
            onBrowse();
            navigate("/discover?tab=emojis");
          }}
        >
          <Compass className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Browse emoji packs</TooltipContent>
    </Tooltip>
  );
}

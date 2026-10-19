import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIntl } from "@/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { cn } from "@/lib/utils";

/**
 * Icon button to Discover's emoji packs. Kept out of `EmojiPicker` so importing
 * it doesn't pull emoji-mart into the main bundle.
 */
export function BrowseEmojiPacksButton({ onBrowse, className }: { onBrowse: () => void; className?: string }) {
  const navigate = useStableNavigate();
  const intl = useIntl();
  const label = intl.formatMessage({ id: "browseEmojiPacksButton.label", defaultMessage: "Browse emoji packs" });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className={cn("size-8 touch:size-11 shrink-0 clip-corner-lg text-muted-foreground", className)}
          onClick={() => {
            onBrowse();
            navigate("/discover?tab=emojis");
          }}
        >
          <Compass className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

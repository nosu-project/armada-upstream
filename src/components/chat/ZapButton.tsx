import { Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The hover-toolbar ⚡ button, shared by the timeline (ChatMessage) and the
 * thread panel (ThreadMessage).
 *
 * It is NOT gated on the author having a lightning address: the dialog's
 * default method is Bitcoin, whose recipient address is derived from the
 * author's pubkey and therefore always exists, and the author may also have
 * declared NIP-A3 payment targets that no kind-0 field mentions. The dialog
 * offers whichever methods that author actually has.
 */
export function ZapButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zap message"
          className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-amber-500"
          onClick={onOpen}
        >
          <Zap className="size-[18px] md:size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Zap message</TooltipContent>
    </Tooltip>
  );
}

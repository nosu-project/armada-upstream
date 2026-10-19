import { Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIntl } from "@/i18n";

/**
 * Hover-toolbar ⚡ button. Not gated on a lightning address: Bitcoin (the default)
 * is derived from the pubkey and always exists, and NIP-A3 targets may exist too.
 */
export function ZapButton({ onOpen }: { onOpen: () => void }) {
  const intl = useIntl();
  const label = intl.formatMessage({ id: "zapButton.zapMessage", defaultMessage: "Zap message" });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-amber-500"
          onClick={onOpen}
        >
          <Zap className="size-[18px] md:size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

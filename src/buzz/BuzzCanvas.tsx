import { ScrollText, X } from "lucide-react";

import { useBuzzCanvas } from "@/buzz/useBuzzCanvas";
import { ChatContent } from "@/components/chat/ChatContent";
import { Button } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/i18n";

/** Read-only bar showing a Buzz channel's shared canvas document (kind 40100) as markdown. */
export function BuzzCanvasBar({
  open,
  relayUrl,
  channelId,
  onClose,
}: {
  open: boolean;
  relayUrl: string;
  channelId: string;
  onClose: () => void;
}) {
  const intl = useIntl();
  const { data: canvas, isLoading } = useBuzzCanvas(open ? relayUrl : undefined, channelId);

  if (!open) return null;
  return (
    <div className="mx-gutter mt-stack clip-corner-lg bg-chrome max-h-[45vh] flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 shrink-0">
        <ScrollText className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex-1">
          <FormattedMessage id="buzzCanvas.title" defaultMessage="Canvas" />
        </span>
        <Button variant="ghost" size="icon" aria-label={intl.formatMessage({ id: "buzzCanvas.close", defaultMessage: "Close canvas" })} className="size-7 touch:size-11 clip-corner-lg" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="px-4 pb-3 overflow-y-auto text-sm">
        {isLoading ? (
          <p className="text-xs text-muted-foreground py-2"><FormattedMessage id="buzzCanvas.loading" defaultMessage="Loading canvas…" /></p>
        ) : canvas?.content ? (
          <ChatContent event={canvas} />
        ) : (
          <p className="text-xs text-muted-foreground py-2"><FormattedMessage id="buzzCanvas.empty" defaultMessage="This channel has no canvas yet." /></p>
        )}
      </div>
    </div>
  );
}

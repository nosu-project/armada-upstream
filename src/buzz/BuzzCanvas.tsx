import { ScrollText, X } from "lucide-react";

import { useBuzzCanvas } from "@/buzz/useBuzzCanvas";
import { ChatContent } from "@/components/chat/ChatContent";
import { Button } from "@/components/ui/button";

/**
 * Read-only view of a Buzz channel's shared canvas document (kind 40100),
 * rendered as markdown in a bar below the channel header (mirrors the
 * pinned-messages bar pattern).
 */
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
  const { data: canvas, isLoading } = useBuzzCanvas(open ? relayUrl : undefined, channelId);

  if (!open) return null;
  return (
    <div className="mx-2 mt-2 clip-corner-lg bg-chrome max-h-[45vh] flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 shrink-0">
        <ScrollText className="size-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex-1">
          Canvas
        </span>
        <Button variant="ghost" size="icon" aria-label="Close canvas" className="size-7" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="px-4 pb-3 overflow-y-auto text-sm">
        {isLoading ? (
          <p className="text-xs text-muted-foreground py-2">Loading canvas…</p>
        ) : canvas?.content ? (
          <ChatContent event={canvas} />
        ) : (
          <p className="text-xs text-muted-foreground py-2">This channel has no canvas yet.</p>
        )}
      </div>
    </div>
  );
}

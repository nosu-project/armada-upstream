import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Stand-in for media held by the media hold (`components/chat/mediaHold.ts`).
 * Renders nothing of the sender's — no blurhash, no thumbnail, no alt — since
 * all of it is theirs to choose; the media is fetched only after "Load".
 */
export function HeldMedia({
  kind,
  count = 1,
  onLoad,
}: {
  kind: "image" | "video";
  count?: number;
  onLoad: () => void;
}) {
  const noun = kind === "video" ? "Video" : count > 1 ? `${count} images` : "Image";
  return (
    <div className="my-1.5 flex max-w-sm items-center gap-3 rounded-lg bg-muted/60 px-3 py-2.5 whitespace-normal">
      <ShieldAlert className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-tight">{noun} not loaded</div>
        <div className="text-xs leading-snug text-muted-foreground">
          From someone you don't know yet. Load only if you trust it.
        </div>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="shrink-0 touch:h-11"
        onClick={(e) => {
          e.stopPropagation();
          onLoad();
        }}
        // Keep the row's long-press menu from claiming the press.
        onPointerDown={(e) => e.stopPropagation()}
      >
        Load
      </Button>
    </div>
  );
}

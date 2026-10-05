import { EyeOff } from "lucide-react";

import { useMediaHoldMode, useTrustMediaHost } from "@/components/chat/mediaHold";
import { Button } from "@/components/ui/button";

import type { MouseEvent, PointerEvent } from "react";

/** Keep the row's tap and long-press menu from claiming a press meant for the card. */
const stopClick = (e: MouseEvent) => e.stopPropagation();
const stopPointer = (e: PointerEvent) => e.stopPropagation();

/**
 * Stand-in for media held by the media hold (`components/chat/mediaHold.ts`).
 * Renders nothing of the sender's — no blurhash, no thumbnail, no alt — since
 * all of it is theirs to choose; the media is fetched only after "Load".
 */
export function HeldMedia({
  kind,
  count = 1,
  host,
  onLoad,
}: {
  kind: "image" | "video" | "audio";
  count?: number;
  /** Held for where it is hosted rather than who sent it. */
  host?: string;
  onLoad: () => void;
}) {
  const mode = useMediaHoldMode();
  const trustHost = useTrustMediaHost();
  const noun = kind === "video" ? "Video" : kind === "audio" ? "Audio" : count > 1 ? `${count} images` : "Image";

  let title: string;
  let detail: string | undefined;
  if (host) {
    title = `${noun} on ${host}`;
  } else if (mode === "never") {
    title = `${noun} not loaded`;
    detail = "You load community media yourself.";
  } else {
    title = `${noun} from a new member`;
    detail = "Loads on its own once they've been around a day.";
  }

  return (
    <div className="my-1.5 flex max-w-sm items-center gap-3 clip-corner-lg bg-muted/60 px-3 py-2 whitespace-normal">
      <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">{title}</div>
        {host && trustHost ? (
          <button
            type="button"
            className="text-xs leading-snug text-muted-foreground underline-offset-2 hover:text-foreground hover:underline touch:min-h-11"
            onClick={(e) => {
              stopClick(e);
              trustHost(host);
            }}
            onPointerDown={stopPointer}
          >
            Always load from {host}
          </button>
        ) : (
          detail && <div className="text-xs leading-snug text-muted-foreground">{detail}</div>
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="shrink-0 touch:h-11"
        onClick={(e) => {
          stopClick(e);
          onLoad();
        }}
        onPointerDown={stopPointer}
      >
        Load
      </Button>
    </div>
  );
}

/** Trailing Load for a held message whose only held content is previews and embeds. */
export function HeldPreviews({ onLoad }: { onLoad: () => void }) {
  return (
    <button
      type="button"
      className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground touch:min-h-11"
      onClick={(e) => {
        stopClick(e);
        onLoad();
      }}
      onPointerDown={stopPointer}
    >
      <EyeOff className="size-3.5" aria-hidden />
      Load previews
    </button>
  );
}

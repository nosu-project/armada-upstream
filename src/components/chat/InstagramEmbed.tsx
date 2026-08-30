import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface InstagramEmbedProps {
  shortcode: string;
  className?: string;
}

/**
 * Renders an Instagram post/reel with a direct iframe to Instagram's own embed
 * page — `instagram.com/p/<shortcode>/embed/captioned/`, no third-party
 * `embed.js`. The `captioned` variant carries the caption text below the media,
 * so a post reads as a rich card even before the media loads.
 *
 * Instagram's embed measures itself and posts a `{"type":"MEASURE"}` message
 * (as a JSON string) from `https://www.instagram.com`; we grow the iframe to
 * that height so a tall caption isn't clipped or scrolled. A minimum height
 * keeps the card from collapsing before the first measurement arrives.
 *
 * Note this is NOT inline video playback: for a reel/video, Instagram's embed
 * shows the poster frame and caption, and its in-frame play button bounces out
 * to instagram.com. True inline playback is gated behind their login/consent
 * walls, so the embed surface itself is the limit — image posts render in full,
 * video renders as a rich preview.
 */
export function InstagramEmbed({ shortcode, className }: InstagramEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.origin !== "https://www.instagram.com") return;
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;

      let data: unknown = e.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }

      const message = data as { type?: string; details?: { height?: number } } | undefined;
      if (!message || typeof message !== "object" || message.type !== "MEASURE") return;

      const measured = message.details?.height;
      if (typeof measured === "number" && measured > 0) {
        setHeight(measured);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <div
      className={cn("max-w-md overflow-hidden rounded-xl border border-border", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <iframe
        ref={iframeRef}
        src={`https://www.instagram.com/p/${shortcode}/embed/captioned/`}
        title="Instagram post"
        className="w-full border-0 bg-white"
        style={{ height: height ?? undefined, minHeight: 480 }}
        scrolling="no"
        allowFullScreen
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}

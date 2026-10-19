import { useEffect, useRef, useState, type ReactNode } from "react";

import { rememberEmbedHeight, seenEmbedHeight } from "@/components/chat/imageDims";
import { useEmbedLiveness } from "@/hooks/useEmbedLiveness";

import { cn } from "@/lib/utils";
import { useIntl } from "@/i18n";

interface InstagramEmbedProps {
  shortcode: string;
  className?: string;
  /** Shown instead when the frame never renders (blocked or unavailable). */
  fallback: ReactNode;
}

/**
 * Direct iframe to `instagram.com/p/<shortcode>/embed/captioned/` (no embed.js),
 * resized from its `{"type":"MEASURE"}` postMessage. Videos show only a poster:
 * inline playback is behind Instagram's login wall.
 */
export function InstagramEmbed({ shortcode, className, fallback }: InstagramEmbedProps) {
  const intl = useIntl();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { failed, markAlive, onLoad } = useEmbedLiveness(iframeRef);
  // Seeded from this session's last measure, so a remount doesn't grow into it.
  const [height, setHeight] = useState<number | null>(() => seenEmbedHeight(`instagram:${shortcode}`) ?? null);

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
      markAlive();

      const measured = message.details?.height;
      if (typeof measured === "number" && measured > 0) {
        setHeight(measured);
        rememberEmbedHeight(`instagram:${shortcode}`, measured);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [markAlive, shortcode]);

  if (failed) return fallback;

  return (
    <div
      className={cn("max-w-md overflow-hidden clip-corner-lg", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <iframe
        ref={iframeRef}
        src={`https://www.instagram.com/p/${shortcode}/embed/captioned/`}
        title={intl.formatMessage({ id: "instagramEmbed.title", defaultMessage: "Instagram post" })}
        className="w-full border-0 bg-white"
        style={{ height: height ?? undefined, minHeight: 480 }}
        scrolling="no"
        allowFullScreen
        loading="lazy"
        onLoad={onLoad}
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from "react";

import { useEmbedLiveness } from "@/hooks/useEmbedLiveness";

import { getBackgroundThemeMode } from "@/lib/colorUtils";
import { cn } from "@/lib/utils";

interface TweetEmbedProps {
  tweetId: string;
  className?: string;
  /** Shown instead when the frame never renders (blocked or unavailable). */
  fallback: ReactNode;
}

/**
 * Direct iframe to `platform.twitter.com/embed/Tweet.html` (`dnt=true`, no
 * scripts), since X starves OG/oEmbed. Resized via `twttr.private.resize`.
 * Theme is read once (the iframe only re-themes on reload), which also keeps
 * this mountable without an AppProvider.
 */
export function TweetEmbed({ tweetId, className, fallback }: TweetEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { failed, markAlive, onLoad } = useEmbedLiveness(iframeRef);

  const resolvedTheme = getBackgroundThemeMode();

  const params = new URLSearchParams({
    id: tweetId,
    dnt: "true",
    theme: resolvedTheme,
  });

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.origin !== "https://platform.twitter.com") return;
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;

      const wrapper = (e.data as Record<string, unknown> | undefined)?.["twttr.embed"] as
        | { method?: string; params?: Array<{ height?: number }> }
        | undefined;
      if (!wrapper || typeof wrapper !== "object") return;
      markAlive();

      if (wrapper.method === "twttr.private.resize") {
        const height = wrapper.params?.[0]?.height;
        if (typeof height === "number" && height > 0) {
          iframeRef.current.style.height = `${height}px`;
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [markAlive]);

  if (failed) return fallback;

  return (
    <div
      className={cn("max-w-md overflow-hidden", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <iframe
        ref={iframeRef}
        src={`https://platform.twitter.com/embed/Tweet.html?${params}`}
        title="Tweet"
        className="w-full border-0"
        style={{ minHeight: 250 }}
        scrolling="no"
        allowFullScreen
        loading="lazy"
        onLoad={onLoad}
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}

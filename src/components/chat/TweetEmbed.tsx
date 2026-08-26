import { useEffect, useRef } from "react";

import { getBackgroundThemeMode } from "@/lib/colorUtils";
import { cn } from "@/lib/utils";

interface TweetEmbedProps {
  tweetId: string;
  className?: string;
}

/**
 * Renders a Twitter/X tweet with a direct iframe to Twitter's own embed page —
 * no third-party scripts, just `platform.twitter.com/embed/Tweet.html` with the
 * tweet id and a `dnt=true` opt-out. This is the path X starves of OG/oEmbed
 * data (so the generic link-preview card collapses to a bare link); the embed
 * page still renders.
 *
 * Listens for `twttr.private.resize` postMessages from the embed to grow the
 * iframe to the tweet's own height, so a long tweet isn't clipped or scrolled.
 * The theme is read once from the live background so the card matches
 * light/dark; the embed is an iframe that only re-themes on a full reload, so
 * there's no live theme subscription (which would also make this component
 * un-mountable without an AppProvider, unlike the renderer that hosts it).
 */
export function TweetEmbed({ tweetId, className }: TweetEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

      if (wrapper.method === "twttr.private.resize") {
        const height = wrapper.params?.[0]?.height;
        if (typeof height === "number" && height > 0) {
          iframeRef.current.style.height = `${height}px`;
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

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
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}

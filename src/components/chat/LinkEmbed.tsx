import { ExternalLink, Link2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useLinkPreview } from "@/hooks/useLinkPreview";
import { extractSpotifyEmbed, extractYouTubeId } from "@/lib/linkEmbed";
import { cn } from "@/lib/utils";

/**
 * Height of a link card's thumbnail well, in px. Fixed (rather than an aspect
 * ratio) so the card's total height doesn't depend on how wide its column is —
 * it stays identical across the loading, resolved and no-thumbnail states.
 */
const THUMBNAIL_HEIGHT = 180;

interface LinkEmbedProps {
  url: string;
  className?: string;
}

/**
 * Unified link embed. YouTube URLs get a click-to-play facade, Spotify URLs
 * get the official embed iframe, everything else gets an OEmbed preview card.
 */
export function LinkEmbed({ url, className }: LinkEmbedProps) {
  const youtubeId = extractYouTubeId(url);
  const spotify = extractSpotifyEmbed(url);

  if (youtubeId) {
    return (
      <div className={cn("max-w-md", className)}>
        <YouTubeEmbed videoId={youtubeId} />
        <EmbedInfoBar url={url} />
      </div>
    );
  }

  if (spotify) {
    return (
      <div className={cn("max-w-md", className)} onClick={(e) => e.stopPropagation()}>
        <iframe
          src={`https://open.spotify.com/embed/${spotify.type}/${spotify.id}`}
          title="Spotify"
          width="100%"
          height={spotify.type === "track" ? 152 : 352}
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
          className="rounded-xl border-0"
          // Sandbox (no allow-top-navigation) blocks the embed from launching the
          // Spotify desktop app via a `spotify:` scheme, which Chrome surfaces as
          // an "open other apps and services on this device" prompt on load.
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    );
  }

  return <LinkPreview url={url} className={className} />;
}

/** Domain + title bar shown under provider embeds. */
function EmbedInfoBar({ url }: { url: string }) {
  const { data } = useLinkPreview(url);
  const domain = displayDomain(url);

  return (
    <div className="px-1 pt-1.5 space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{data?.provider_name || domain}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-full hover:bg-primary/10 hover:text-primary transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-3" />
          <span>Open</span>
        </a>
      </div>
      {/* One reserved line: the title arrives asynchronously, so the bar keeps a
          line box to avoid collapsing, but doesn't hold open a second one that
          most titles never fill. */}
      <p className="min-h-5 text-sm font-semibold leading-snug line-clamp-2">{data?.title}</p>
    </div>
  );
}

/** Extracts the display domain from a URL (e.g. "www.example.com" -> "example.com"). */
function displayDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Rich link preview card rendered from OEmbed data.
 *
 * The bulk of the card's height is fixed across the loading, resolved,
 * resolved-without-thumbnail and thumbnail-failed states: a row that resizes
 * after mount shoves everything below it in the timeline, and a preview that
 * resolved from a skeleton into a hero card (or collapsed into a bare link)
 * moved the reading position by ~200px, which made scrolling back through
 * history judder. So the thumbnail well stays a fixed {@link THUMBNAIL_HEIGHT}px
 * box that falls back to an icon placeholder. The text rows below it size to
 * their content — reserving two title lines and an author line left an obvious
 * gap under the (usually one-line) title, since most providers return neither a
 * wrapped title nor an author at all.
 */
function LinkPreview({ url, className }: { url: string; className?: string }) {
  const { data, isLoading } = useLinkPreview(url);
  // Thumbnail 404s/hotlink blocks are common; swap to the placeholder rather
  // than hiding the well (hiding it would resize the row a second time).
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumbnail = !thumbFailed ? data?.thumbnail_url : undefined;
  const domain = displayDomain(url);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group block max-w-md rounded-xl border border-border overflow-hidden",
        "hover:bg-secondary/40 transition-colors",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="relative w-full overflow-hidden bg-muted"
        style={{ height: THUMBNAIL_HEIGHT }}
      >
        {isLoading ? (
          <Skeleton className="absolute inset-0 rounded-none" />
        ) : thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Link2 className="size-8 text-muted-foreground/40" />
          </div>
        )}
      </div>

      <div className="px-3.5 py-2.5 space-y-0.5">
        <div className="flex items-center gap-1.5 h-4 text-xs text-muted-foreground">
          <span className="truncate">{data?.provider_name || domain}</span>
          <ExternalLink className="size-3 ml-auto shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity" />
        </div>
        <p className="text-sm font-semibold leading-snug line-clamp-2">
          {isLoading ? <Skeleton className="h-4 w-3/4" /> : data?.title ?? url}
        </p>
        {data?.author_name && (
          <p className="text-xs text-muted-foreground line-clamp-1">
            {data.author_name}
          </p>
        )}
      </div>
    </a>
  );
}

/**
 * YouTube thumbnail sizes to try, in preference order. YouTube's CDN serves a
 * 120×90 gray placeholder when a size doesn't exist, so we probe off-screen.
 */
const THUMBNAIL_SIZES = ["sddefault", "hqdefault"] as const;

function thumbnailUrl(videoId: string, size: string): string {
  return `https://i.ytimg.com/vi/${videoId}/${size}.jpg`;
}

/** Probe thumbnail sizes off-screen and resolve with the first valid URL. */
function findThumbnail(videoId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;

    function tryIndex(i: number) {
      if (i >= THUMBNAIL_SIZES.length) {
        if (!settled) {
          settled = true;
          resolve(null);
        }
        return;
      }

      const img = new Image();
      img.onload = () => {
        if (settled) return;
        if (img.naturalWidth <= 120 && img.naturalHeight <= 90) {
          tryIndex(i + 1);
        } else {
          settled = true;
          resolve(thumbnailUrl(videoId, THUMBNAIL_SIZES[i]));
        }
      };
      img.onerror = () => {
        if (!settled) tryIndex(i + 1);
      };
      img.src = thumbnailUrl(videoId, THUMBNAIL_SIZES[i]);
    }

    tryIndex(0);
  });
}

/**
 * YouTube embed with a privacy-respecting click-to-load facade: no requests
 * are made to YouTube until the user explicitly clicks play.
 */
export function YouTubeEmbed({ videoId, className }: { videoId: string; className?: string }) {
  const [activated, setActivated] = useState(false);
  const [resolvedThumb, setResolvedThumb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResolvedThumb(null);

    findThumbnail(videoId).then((url) => {
      if (!cancelled) setResolvedThumb(url);
    });

    return () => {
      cancelled = true;
    };
  }, [videoId]);

  return (
    <div
      className={cn("rounded-xl overflow-hidden border border-border", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
        {activated ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`}
            title="YouTube video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        ) : (
          <button
            type="button"
            className="absolute inset-0 w-full h-full cursor-pointer bg-black group"
            onClick={() => setActivated(true)}
            aria-label="Play video"
          >
            {resolvedThumb && (
              <img src={resolvedThumb} alt="" className="absolute inset-0 w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className={cn(
                  "flex items-center justify-center",
                  "w-[68px] h-[48px] rounded-xl",
                  "bg-[#212121]/80 group-hover:bg-[#ff0000] transition-colors duration-200",
                )}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white ml-0.5">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
          </button>
        )}
      </div>
    </div>
  );
}

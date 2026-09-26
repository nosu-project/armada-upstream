import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { InstagramEmbed } from "@/components/chat/InstagramEmbed";
import { Lightbox, type LightboxItem } from "@/components/chat/Lightbox";
import { TweetEmbed } from "@/components/chat/TweetEmbed";
import { toast } from "@/hooks/useToast";
import { useLinkPreview, useRichEmbed } from "@/hooks/useLinkPreview";
import { useMediaSrc } from "@/hooks/useMediaPolicy";
import { writeClipboardText } from "@/lib/clipboard";
import { useEmbedPauseEpoch } from "@/lib/embedPause";
import {
  extractInstagramShortcode,
  extractSpotifyEmbed,
  extractStreamableId,
  extractTweetId,
  extractYouTubeId,
} from "@/lib/linkEmbed";
import { faviconUrl } from "@/lib/faviconUrl";
import { fullDateTime } from "@/lib/formatTime";
import type { RichEmbedImage } from "@/lib/richEmbed";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import {
  hasNativeYouTubePlayer,
  needsNativeYouTubePlayer,
  openNativeYouTubeVideo,
  openYouTubeWatchPage,
} from "@/lib/nativeYouTube";
import { cn } from "@/lib/utils";

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
  const tweetId = extractTweetId(url);
  const instagramShortcode = extractInstagramShortcode(url);
  const streamableId = extractStreamableId(url);
  // Remounting the provider iframe is the only way to stop its playback.
  const pauseEpoch = useEmbedPauseEpoch();

  if (youtubeId) {
    return (
      <div className={cn("max-w-md", className)}>
        <YouTubeEmbed videoId={youtubeId} />
        <EmbedInfoBar url={url} />
      </div>
    );
  }

  if (tweetId) {
    return <TweetEmbed tweetId={tweetId} className={className} />;
  }

  if (instagramShortcode) {
    return <InstagramEmbed shortcode={instagramShortcode} className={className} />;
  }

  if (spotify) {
    return (
      <div className={cn("max-w-md", className)} onClick={(e) => e.stopPropagation()}>
        <iframe
          key={pauseEpoch}
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

  if (streamableId) {
    return (
      <div className={cn("max-w-md", className)} onClick={(e) => e.stopPropagation()}>
        <div
          className="relative w-full overflow-hidden rounded-xl border border-border bg-black"
          style={{ paddingBottom: "56.25%" }}
        >
          <iframe
            key={pauseEpoch}
            src={`https://streamable.com/e/${streamableId}`}
            title="Streamable video"
            // `allow="fullscreen"` supersedes the `allowFullScreen` attribute
            // (which the browser warns about if both are set), so this is the
            // only fullscreen grant.
            allow="autoplay; fullscreen; picture-in-picture"
            loading="lazy"
            className="absolute inset-0 h-full w-full border-0"
          />
        </div>
        <EmbedInfoBar url={url} />
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
      {data?.title && <p className="text-sm font-semibold leading-snug line-clamp-2">{data.title}</p>}
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

/** Caps a preview image is fitted into, without upscaling. */
const PREVIEW_MAX_W = 400;
const PREVIEW_MAX_H = 320;
/** An image this small on both axes is a logo/avatar, shown as a side thumbnail. */
const SMALL_IMAGE_MAX = 200;
/** Images shown in a multi-image grid; the rest are behind `+N` and the lightbox. */
const GRID_MAX = 4;

/** Rich link preview card, Discord-style: text, fields, media, footer. */
function LinkPreview({ url, className }: { url: string; className?: string }) {
  const { data: embed, isLoading } = useRichEmbed(url);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  // The lightbox resolves the un-proxied URL through the media policy itself,
  // as it does for a message image; it gets the full-size original where the
  // source names one.
  const lightboxMedia = useMemo<LightboxItem[]>(
    () =>
      (embed?.images ?? []).flatMap((img): LightboxItem[] => {
        const src = sanitizeImageSrc(img.full) ?? sanitizeImageSrc(img.thumb);
        if (!src) return [];
        return [{ url: src, dim: img.width && img.height ? `${img.width}x${img.height}` : undefined }];
      }),
    [embed?.images],
  );
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const nextImage = useCallback(
    () => setLightboxIndex((i) => (i === null ? i : Math.min(lightboxMedia.length - 1, i + 1))),
    [lightboxMedia.length],
  );
  const prevImage = useCallback(() => setLightboxIndex((i) => (i === null ? i : Math.max(0, i - 1))), []);

  if (isLoading) {
    return (
      <div className={cn("max-w-md rounded-md border-l-4 border-primary bg-secondary/40 overflow-hidden", className)}>
        <div className="px-3 py-2.5 space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }

  // No preview data — fall back to a plain inline link.
  if (!embed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>
    );
  }

  const images = embed.images;
  const single = images.length === 1 ? images[0] : undefined;
  const singleW = single?.width ?? naturalSize?.w;
  const singleH = single?.height ?? naturalSize?.h;
  const small = !!singleW && !!singleH && singleW <= SMALL_IMAGE_MAX && singleH <= SMALL_IMAGE_MAX;
  // A footer that names the source stands in for the provider line.
  const provider = embed.provider ?? (embed.footer ? undefined : displayDomain(url));

  return (
    // A `<button>` can't nest in an `<a>`, so instead of wrapping the card in a
    // link we lay a full-card link OVERLAY under inert content: clicks fall
    // through the `pointer-events-none` content to the anchor, and the copy
    // button and the images re-enable pointer events as the exceptions. That
    // keeps the rest of the card behaving as a link.
    <div
      className={cn(
        "group relative block w-fit max-w-md rounded-md border-l-4 border-primary bg-secondary/40 overflow-hidden",
        "hover:bg-secondary/60 transition-colors",
        className,
      )}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={embed.title || embed.author?.name || provider || displayDomain(url)}
        className="absolute inset-0 z-0"
        onClick={(e) => e.stopPropagation()}
      />

      <div className="pointer-events-none relative px-3 py-2.5">
        <div className="flex gap-3">
          {/* Right padding clears the copy button in the top-right corner. */}
          <div className="min-w-0 flex-1 space-y-1.5 pr-6 touch:pr-8">
            {provider && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                {/* One favicon per card, on the footer when there is one. */}
                {!embed.footer && <SiteIcon url={url} />}
                <span className="truncate">{provider}</span>
              </p>
            )}
            {embed.author && <EmbedAuthor name={embed.author.name} icon={embed.author.icon} />}
            {embed.title && (
              <p className="text-sm font-semibold leading-snug text-primary line-clamp-2">{embed.title}</p>
            )}
            {embed.description && (
              <p className="text-sm leading-snug whitespace-pre-line break-words line-clamp-6">
                {embed.description}
              </p>
            )}
            {embed.fields && (
              <dl className="grid grid-cols-3 gap-x-6 gap-y-1 pt-0.5">
                {embed.fields.map((field) => (
                  <div key={field.name} className="min-w-0">
                    <dt className="text-xs font-semibold">{field.name}</dt>
                    <dd className="text-sm truncate">{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          {single && small && (
            <div className="mt-6 touch:mt-8">
              <EmbedImage image={single} variant="small" onOpen={() => setLightboxIndex(0)} />
            </div>
          )}
        </div>

        {single && !small && (
          <div className="mt-2.5 w-fit max-w-full">
            <EmbedImage
              image={single}
              variant="single"
              onOpen={() => setLightboxIndex(0)}
              onSize={setNaturalSize}
            />
          </div>
        )}

        {images.length > 1 && (
          <div className="mt-2.5 grid w-[min(100%,25rem)] grid-cols-2 gap-1">
            {images.slice(0, GRID_MAX).map((image, i) => (
              <div key={`${i}:${image.thumb}`} className="relative">
                <EmbedImage image={image} variant="tile" onOpen={() => setLightboxIndex(i)} />
                {i === GRID_MAX - 1 && images.length > GRID_MAX && (
                  <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/60 text-lg font-semibold text-white">
                    +{images.length - GRID_MAX}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {embed.footer && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <SiteIcon url={url} />
            <span className="truncate">
              {embed.footer.text}
              {embed.footer.timestamp !== undefined && <> • {fullDateTime(embed.footer.timestamp)}</>}
            </span>
          </p>
        )}
      </div>

      <CopyLinkButton url={url} />

      {lightboxIndex !== null && lightboxMedia.length > 0 && (
        <Lightbox
          media={lightboxMedia}
          currentIndex={Math.min(lightboxIndex, lightboxMedia.length - 1)}
          onClose={closeLightbox}
          onNext={nextImage}
          onPrev={prevImage}
        />
      )}
    </div>
  );
}

/**
 * The linked site's favicon, beside whichever line names the source. It comes
 * from the favicon service rather than the site itself, like every other
 * favicon in the app, so the site does not see who scrolled past its link.
 */
function SiteIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 rounded-sm object-contain"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** Author line with an optional avatar, loaded under the media policy. */
function EmbedAuthor({ name, icon }: { name: string; icon?: string }) {
  const src = useMediaSrc(sanitizeImageSrc(icon));
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex items-center gap-2 min-w-0">
      {src && !failed && (
        <img
          src={src}
          alt=""
          className="size-6 shrink-0 rounded-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      <p className="text-sm font-semibold leading-snug truncate">{name}</p>
    </div>
  );
}

/**
 * One preview image. The thumbnail is whatever the linked page named, on a
 * host of its choosing — under the media policy like a message image (proxied
 * for a stranger's host). It opens the lightbox rather than the link: the
 * button re-enables pointer events in front of the card-wide link overlay.
 *
 * A `single` image is shown whole, at its own aspect ratio — a page's image is
 * usually the content (an artwork, a post's picture), and a cover crop cuts it
 * to a strip. Known dimensions reserve the box before load; otherwise the
 * loaded image settles into the same caps.
 */
function EmbedImage({
  image,
  variant,
  onOpen,
  onSize,
}: {
  image: RichEmbedImage;
  variant: "single" | "small" | "tile";
  onOpen: () => void;
  onSize?: (size: { w: number; h: number }) => void;
}) {
  const src = useMediaSrc(sanitizeImageSrc(image.thumb));
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;

  const w = image.width ?? natural?.w;
  const h = image.height ?? natural?.h;
  const box = variant === "single" && w && h ? fitPreviewBox(w, h) : undefined;

  return (
    <button
      type="button"
      aria-label="View image"
      className={cn(
        "pointer-events-auto relative z-10 block max-w-full cursor-zoom-in rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        variant === "tile" && "w-full",
      )}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
    >
      <img
        src={src}
        alt=""
        className={cn(
          "block rounded-md",
          variant === "small" && "size-20 shrink-0 object-cover",
          variant === "tile" && "aspect-square w-full object-cover",
          variant === "single" &&
            (box ? "max-w-full h-auto object-cover" : "max-w-[min(100%,25rem)] max-h-80 w-auto h-auto"),
        )}
        style={box ? { aspectRatio: box.aspectRatio, width: box.maxWidth } : undefined}
        loading="lazy"
        decoding="async"
        onLoad={(e) => {
          const { naturalWidth, naturalHeight } = e.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            const size = { w: naturalWidth, h: naturalHeight };
            setNatural(size);
            onSize?.(size);
          }
        }}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

/**
 * Fits an image into the preview caps without upscaling, as a persistent
 * aspect ratio plus the capped width — the same scheme as a message image, so
 * a portrait image is pre-narrowed rather than clamped by height after load.
 */
function fitPreviewBox(w: number, h: number): { aspectRatio: string; maxWidth: number } {
  const scale = Math.min(1, PREVIEW_MAX_W / w, PREVIEW_MAX_H / h);
  return { aspectRatio: `${w} / ${h}`, maxWidth: Math.round(w * scale) };
}

/**
 * Copy-link affordance in the top-right corner of a link preview card. It
 * copies the URL rather than following it, and re-enables pointer events (its
 * container is inert) so it's the one interactive element in front of the
 * card-wide link overlay. Always visible.
 */
function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    writeClipboardText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        toast({ title: "Copied link" });
      },
      () => toast({ title: "Couldn't copy link", variant: "destructive" }),
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy link"
      aria-label="Copy link"
      className={cn(
        "absolute top-1 right-1 z-10 grid place-items-center size-7 touch:size-9 rounded-md",
        "text-muted-foreground hover:text-primary hover:bg-secondary transition-colors",
      )}
    >
      {copied ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />}
    </button>
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
  // The pause epoch the player was started in: pausing media bumps the epoch,
  // which returns the embed to its facade and tears the player down.
  const pauseEpoch = useEmbedPauseEpoch();
  const [activatedAt, setActivatedAt] = useState<number | null>(null);
  const activated = activatedAt === pauseEpoch;
  const [resolvedThumb, setResolvedThumb] = useState<string | null>(null);
  const [nativeOpenFailed, setNativeOpenFailed] = useState(false);
  const nativeIos = needsNativeYouTubePlayer();

  const play = () => {
    if (!nativeIos) {
      setActivatedAt(pauseEpoch);
      return;
    }
    if (nativeOpenFailed) {
      openYouTubeWatchPage(videoId);
      return;
    }

    // WKWebView cannot attach an HTTP Referer to this nested iframe when the
    // parent is capacitor://localhost. Use the native referrer-bearing player;
    // an older binary without that plugin falls back to the ordinary watch
    // page instead of knowingly rendering YouTube error 153.
    if (!hasNativeYouTubePlayer()) {
      openYouTubeWatchPage(videoId);
      return;
    }
    void openNativeYouTubeVideo(videoId).then((opened) => {
      setNativeOpenFailed(!opened);
    });
  };

  useEffect(() => {
    let cancelled = false;
    setResolvedThumb(null);
    setNativeOpenFailed(false);

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
            // YouTube requires an HTTP Referer (or equivalent app identity).
            // Let the browser send this deployment's own origin so a
            // self-hosted client never inherits a hard-coded public host or
            // packaged app id from the web bundle.
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 w-full h-full"
          />
        ) : (
          <button
            type="button"
            className="absolute inset-0 w-full h-full cursor-pointer bg-black group"
            onClick={play}
            aria-label={nativeOpenFailed ? "Open video on YouTube" : "Play video"}
          >
            {resolvedThumb && (
              <img src={resolvedThumb} alt="" className="absolute inset-0 w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 flex items-center justify-center">
              {nativeOpenFailed ? (
                <span className="rounded-full bg-black/85 px-4 py-2 text-sm font-medium text-white">
                  Open on YouTube
                </span>
              ) : (
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
              )}
            </div>
          </button>
        )}
      </div>
    </div>
  );
}

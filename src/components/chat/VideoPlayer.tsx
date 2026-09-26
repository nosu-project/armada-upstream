import { Capacitor } from "@capacitor/core";
import { Download, Expand, Loader2, Pause, Play, Share2, Volume1, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { MediaFallback } from "@/components/chat/MediaFallback";
import { MediaSpoilerCover } from "@/components/chat/MediaSpoiler";
import { useChatImageMenu } from "@/contexts/ChatImageMenuContext";
import { useRoutedCandidates } from "@/hooks/useBlossomCandidates";
import { useLongPress } from "@/hooks/useLongPress";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { usePlayerControls } from "@/hooks/usePlayerControls";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { useVideoThumbnail } from "@/hooks/useVideoThumbnail";
import { toast } from "@/hooks/useToast";
import { isValidBlurhash } from "@/lib/blurhash";
import { BLANK_POSTER } from "@/lib/blankPoster";
import { downloadUrl } from "@/lib/downloadFile";
import { formatTime } from "@/lib/formatTime";
import { companionEncryption } from "@/lib/imeta";
import { canShareFiles, shareFile } from "@/lib/share";
import { cn } from "@/lib/utils";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ImetaEncryption } from "@/lib/imeta";
import type { MutableRefObject, Ref } from "react";

interface VideoPlayerProps {
  src: string;
  /** Poster image URL (from the imeta `thumb`/`image` field). */
  poster?: string;
  /** Sender-declared alternative sources (imeta `fallback`), same key and nonce. */
  fallbacks?: string[];
  /** Pixel dimensions from the imeta `dim` field, e.g. "1280x720". */
  dim?: string;
  /** Blurhash placeholder shown while an encrypted blob downloads/decrypts. */
  blurhash?: string;
  /** MIME type of the video (used as the decrypted Blob's type). */
  mime?: string;
  /** AES-GCM decryption params for client-encrypted (Concord/Vector) blobs. */
  encryption?: ImetaEncryption;
  /** Video title shown in OS media controls. */
  title?: string;
  /** Artist / author name shown in OS media controls. */
  artist?: string;
  /** When true, the video auto-plays muted without requiring a click. */
  autoPlay?: boolean;
  /**
   * Present as a GIF: autoplay, muted, no controls, transparent chrome.
   * Set for Tenor/Giphy-style `.mp4` renditions that are really animated GIFs.
   */
  gif?: boolean;
  /**
   * Hide the in-player Download/Share (⋯) menu. Set when a host already offers
   * those actions in its own chrome (the lightbox top bar) so they don't double.
   */
  hideActionsMenu?: boolean;
  /** Handle on the underlying element, for callers that pause it themselves. */
  videoRef?: Ref<HTMLVideoElement>;
  /** Covered until clicked (imeta `content-warning`). */
  spoiler?: boolean;
  /** The sender's description (imeta `alt`). */
  alt?: string;
  className?: string;
}

/** Parses an imeta `dim` string like "1280x720" into `{ width, height }`. */
function parseDim(dim: string | undefined): { width: number; height: number } | undefined {
  if (!dim) return undefined;
  const match = dim.match(/^(\d+)x(\d+)$/);
  if (!match) return undefined;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!width || !height) return undefined;
  return { width, height };
}

/**
 * Inline chat video player — custom chrome ported from Ditto.
 *
 * A single real `<video>` sits under a stack of overlays: a blurhash / poster
 * placeholder (rendered as a plain `<img>` so it never triggers the WebView's
 * gray native placeholder — the element itself carries a transparent
 * {@link BLANK_POSTER}), a big centered play button before first play, and a
 * bottom control bar (play/pause, mute + reveal-on-hover volume, scrubber,
 * time, fullscreen) plus a device-agnostic Download/Share (⋯) menu.
 *
 * Encrypted (Concord/Vector) attachments are AES-GCM ciphertext on Blossom, so
 * the src is fetched + decrypted to an object URL — and the same object URL is
 * what the Download/Share menu hands to the OS, so a link to ciphertext (which
 * the recipient couldn't read) is never shared.
 */
export function VideoPlayer({
  src,
  poster,
  dim,
  blurhash,
  mime,
  encryption,
  fallbacks,
  title,
  artist,
  autoPlay,
  gif = false,
  hideActionsMenu = false,
  videoRef: forwardedRef,
  spoiler = false,
  alt,
  className,
}: VideoPlayerProps) {
  const [revealed, setRevealed] = useState(false);
  const spoilerCover = spoiler && !revealed ? <MediaSpoilerCover onReveal={() => setRevealed(true)} /> : null;
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Merge our own ref with any forwarded one (the lightbox pauses the element
  // itself when its slot stops being current).
  const setVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      videoRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) (forwardedRef as MutableRefObject<HTMLVideoElement | null>).current = node;
    },
    [forwardedRef],
  );

  const { resolved, onError, failed, fallbackProps } = useMediaWithFallback({ url: src, encryption, mime, fallbacks });
  const ready = resolved.status === "ready";
  const mediaSrc = ready ? resolved.src : "";

  // An encrypted poster is ciphertext on Blossom, decrypted with the same key
  // and nonce as its video (only the key/nonce carry over, not the `ox`). The
  // poster is sender-named too, so it goes under the same media policy as the
  // video — proxied where the video is.
  const posterEncryption = useMemo(() => companionEncryption(encryption), [encryption]);
  const posterRoute = useRoutedCandidates(poster || undefined);
  const posterCandidate = posterRoute.sources[0];
  const resolvedPoster = useResolvedMediaSrc({
    url: posterCandidate ?? "",
    encryption: posterEncryption,
    mime: "image/jpeg",
  });
  const posterSrc = posterCandidate && resolvedPoster.status === "ready" ? resolvedPoster.src : undefined;

  // No supplied poster → generate one from the first frame (mainly for Android
  // WebView, which won't paint one on its own). Pointless before the source
  // resolves, and skipped entirely in GIF mode. Cached under the pre-resolution
  // `src`, since `mediaSrc` is a per-decrypt object URL for encrypted media.
  const generatedPoster = useVideoThumbnail({
    src: gif ? "" : mediaSrc,
    identity: src,
    poster: posterSrc,
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  // True once the video element has decoded its first frame.
  const [videoReady, setVideoReady] = useState(false);
  // True once the poster <img> overlay has actually finished loading.
  const [posterLoaded, setPosterLoaded] = useState(false);
  // Aspect ratio discovered at runtime when there's no `dim` tag — from the
  // thumbnail's natural size, or the video's own metadata. Until something real
  // is known we default to 16:9 so the player never renders as a square.
  const [discoveredAspect, setDiscoveredAspect] = useState<string | undefined>(undefined);

  const dimensions = parseDim(dim);
  const aspectRatio = dimensions
    ? `${dimensions.width} / ${dimensions.height}`
    : (discoveredAspect ?? "16 / 9");

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const { showControls, revealControls, scheduleHide, isMuted, volume, toggleMute, handleVolumeChange } =
    usePlayerControls({ mediaRef: videoRef, containerRef, isPlaying });

  // Long-press (touch) / right-click (desktop) menu, mirroring how message
  // images offer Save / Share. The ambient menu is null outside a chat message
  // row (e.g. in the lightbox, which carries its own top-bar actions), where
  // this wiring becomes inert and the native menu is left alone.
  const chatMenu = useChatImageMenu();
  const mediaActions = useMemo<MessageActionItem[]>(() => {
    if (gif || !mediaSrc) return [];
    const list: MessageActionItem[] = [
      { id: "vid-save", label: "Save video", icon: Download, onSelect: () => void saveVideo(mediaSrc, { url: src, mime }) },
    ];
    if (canShareFiles()) {
      list.push({
        id: "vid-share",
        label: "Share video",
        icon: Share2,
        onSelect: () => void shareVideo(mediaSrc, { url: src, mime }),
      });
    }
    return list;
  }, [gif, mediaSrc, src, mime]);
  const longPress = useLongPress(
    chatMenu?.isTouch && mediaActions.length > 0 ? () => chatMenu.openSheet(mediaActions) : undefined,
  );

  // Desktop right-click: stage the video's actions and let the event bubble to
  // the message row's context menu, which shows them above the message's. On
  // touch our long-press sheet is the menu, so suppress the platform callout.
  const handleContextMenu = (e: React.MouseEvent) => {
    longPress.onContextMenu(e);
    if (mediaActions.length === 0) return;
    if (chatMenu?.isTouch) e.preventDefault();
    else if (chatMenu) chatMenu.stage(mediaActions);
  };

  // Muted autoplay when requested. Uses `loadeddata` to ensure the element is
  // ready before calling play().
  const autoplayAttempted = useRef(false);
  useEffect(() => {
    if (gif || !autoPlay || !mediaSrc) return;
    autoplayAttempted.current = false;

    const video = videoRef.current;
    if (!video) return;

    const attemptPlay = () => {
      if (autoplayAttempted.current) return;
      autoplayAttempted.current = true;
      video.muted = true;
      video.play().catch(() => {
        // Autoplay blocked by browser — leave paused, user can click to play.
      });
    };

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      attemptPlay();
    } else {
      video.addEventListener("loadeddata", attemptPlay, { once: true });
      return () => video.removeEventListener("loadeddata", attemptPlay);
    }
  }, [gif, autoPlay, mediaSrc]);

  // Media Session API — OS lock-screen / notification controls.
  useEffect(() => {
    if (gif) return;
    if (!("mediaSession" in navigator)) return;
    if (!hasStarted) return;
    const video = videoRef.current;
    if (!video) return;

    const art = generatedPoster || posterSrc;
    const artwork: MediaImage[] = art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || "Video",
      artist: artist || "",
      artwork,
    });

    navigator.mediaSession.setActionHandler("play", () => video.play().catch(() => {}));
    navigator.mediaSession.setActionHandler("pause", () => video.pause());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null) video.currentTime = details.seekTime;
    });
    navigator.mediaSession.setActionHandler("previoustrack", null);
    navigator.mediaSession.setActionHandler("nexttrack", null);

    return () => {
      if (!("mediaSession" in navigator)) return;
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("seekto", null);
    };
  }, [gif, hasStarted, title, artist, posterSrc, generatedPoster]);

  // Keep OS playback state in sync.
  useEffect(() => {
    if (gif || !("mediaSession" in navigator) || !hasStarted) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [gif, isPlaying, hasStarted]);

  // Keep OS position/scrubber in sync.
  useEffect(() => {
    if (gif || !("mediaSession" in navigator) || !hasStarted || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: videoRef.current?.playbackRate ?? 1,
        position: Math.min(currentTime, duration),
      });
    } catch {
      /* setPositionState may throw on some browsers */
    }
  }, [gif, currentTime, duration, hasStarted]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  };

  const handleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    videoRef.current?.requestFullscreen?.();
  };

  const handleSeek = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    const bar = progressRef.current;
    if (!video || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
  };

  const handleVideoClick = (e: React.MouseEvent) => {
    // A long-press that just opened the action sheet swallows the click that
    // follows the finger's release, so it doesn't also toggle playback.
    longPress.onClick(e);
    if (e.defaultPrevented) return;
    e.stopPropagation();
    if (!hasStarted) {
      videoRef.current?.play();
      return;
    }
    togglePlay(e);
    revealControls();
  };

  // ── GIF mode: chromeless, autoplaying, looping — no custom controls. ──
  if (gif) {
    return (
      <div
        className={cn("relative my-1.5 rounded-xl overflow-hidden max-w-xs bg-transparent", className)}
        style={{ aspectRatio }}
        onClick={(e) => e.stopPropagation()}
      >
        {spoilerCover}
        {ready ? (
          <video
            ref={setVideoRef}
            src={mediaSrc}
            autoPlay
            loop
            muted
            playsInline
            disablePictureInPicture
            preload="metadata"
            aria-label={alt}
            className="w-full h-full object-contain"
            onError={onError}
          />
        ) : failed ? (
          <MediaFallback {...fallbackProps} label="GIF" />
        ) : (
          <div className="relative w-full h-full flex items-center justify-center">
            {isValidBlurhash(blurhash) && (
              <BlurhashCanvas hash={blurhash} className="absolute inset-0 w-full h-full" />
            )}
            <Loader2 className="relative size-6 animate-spin text-white/80" />
          </div>
        )}
      </div>
    );
  }

  if (failed) {
    return <MediaFallback {...fallbackProps} label="Video" />;
  }

  return (
    <div
      ref={containerRef}
      data-video-player
      className={cn(
        "relative my-1.5 rounded-xl overflow-hidden max-w-md border border-border bg-black group",
        className,
      )}
      style={{ aspectRatio }}
      onMouseMove={revealControls}
      onMouseLeave={() => {
        if (isPlaying) scheduleHide();
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={handleContextMenu}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
    >
      {spoilerCover}

      {/* Blurhash placeholder — until a thumbnail or playback frame appears. */}
      {isValidBlurhash(blurhash) && !hasStarted && !(generatedPoster && posterLoaded) && (
        <BlurhashCanvas hash={blurhash} className="absolute inset-0 w-full h-full" />
      )}

      <video
        ref={setVideoRef}
        // An empty string would resolve against the document URL and make the
        // element try to load the page itself.
        src={mediaSrc || undefined}
        aria-label={alt}
        // A transparent poster keeps the WebView from painting its own gray
        // placeholder behind our overlays.
        poster={BLANK_POSTER}
        className={cn(
          "absolute inset-0 w-full h-full object-cover cursor-pointer",
          // In real fullscreen the element fills the screen, so object-cover
          // would crop it — contain it and reset the layout constraints.
          "fullscreen:object-contain fullscreen:static fullscreen:max-h-none fullscreen:h-full fullscreen:w-full",
          // The element shows a transparent poster until playback, so keep it
          // hidden while the thumbnail <img> covers it. Reveal on playback, or —
          // with no thumbnail — as soon as it decodes a frame.
          "transition-opacity duration-150",
          hasStarted || (videoReady && !generatedPoster) ? "opacity-100" : "opacity-0",
        )}
        playsInline
        loop
        preload="metadata"
        {...({ "webkit-playsinline": "true" } as React.HTMLAttributes<HTMLVideoElement>)}
        {...({ "x-webkit-airplay": "allow" } as React.HTMLAttributes<HTMLVideoElement>)}
        onClick={handleVideoClick}
        onPlay={() => {
          setIsPlaying(true);
          setHasStarted(true);
        }}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => {
          const video = videoRef.current;
          if (!video) return;
          setDuration(video.duration ?? 0);
          if (!dimensions && video.videoWidth > 0 && video.videoHeight > 0) {
            setDiscoveredAspect((prev) => prev ?? `${video.videoWidth} / ${video.videoHeight}`);
          }
        }}
        onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
        onLoadedData={() => setVideoReady(true)}
        onError={onError}
      />

      {/* Still resolving (downloading / decrypting) — a spinner over the blur. */}
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="size-6 animate-spin text-white/80" />
        </div>
      )}

      {/* Poster/thumbnail overlay — a plain <img> so it never triggers the
          WebView's native video placeholder. Visible until playback starts. */}
      {generatedPoster && !hasStarted && (
        <img
          src={generatedPoster}
          alt=""
          aria-hidden
          className={cn(
            "absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-150",
            posterLoaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={(e) => {
            setPosterLoaded(true);
            const img = e.currentTarget;
            if (!dimensions && img.naturalWidth > 0 && img.naturalHeight > 0) {
              setDiscoveredAspect((prev) => prev ?? `${img.naturalWidth} / ${img.naturalHeight}`);
            }
          }}
          decoding="async"
        />
      )}

      {/* Download / Share (⋯) menu — reachable before playback too, so a video
          can be saved without playing it. Hidden where a host offers its own. */}
      {ready && !hideActionsMenu && (
        <div
          className={cn(
            "absolute top-2 right-2 z-10 transition-opacity duration-200",
            showControls || !hasStarted ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          <VideoDownloadButton src={resolved.src} nameHint={src} mime={mime} />
        </div>
      )}

      {/* Big centered play button before first play — held back until there's
          something real behind it (a loaded poster or a decoded frame). */}
      {ready && !hasStarted && (videoReady || posterLoaded) && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer"
          onClick={handleVideoClick}
        >
          <div className="size-16 rounded-full bg-black/60 flex items-center justify-center backdrop-blur-sm">
            <Play className="size-8 text-white ml-1" fill="white" />
          </div>
        </div>
      )}

      {/* Bottom control bar */}
      {hasStarted && (
        <div
          className={cn(
            "absolute bottom-0 left-0 right-0 transition-opacity duration-200",
            "bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-8 pb-2 px-3",
            showControls ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          {/* Progress bar */}
          <div
            ref={progressRef}
            className="w-full h-1 bg-white/30 rounded-full cursor-pointer mb-2 group/progress"
            onClick={handleSeek}
          >
            <div className="h-full bg-primary rounded-full relative" style={{ width: `${progress}%` }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 size-3 bg-primary rounded-full opacity-0 group-hover/progress:opacity-100 transition-opacity" />
            </div>
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-3">
            {/* Play/Pause */}
            <button
              type="button"
              onClick={togglePlay}
              className="text-white hover:text-white/80 transition-colors"
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="size-5" fill="white" />
              ) : (
                <Play className="size-5 ml-0.5" fill="white" />
              )}
            </button>

            {/* Volume: icon toggles mute, slider sets level */}
            <div className="flex items-center gap-1.5 group/vol">
              <button
                type="button"
                onClick={toggleMute}
                className="text-white hover:text-white/80 transition-colors shrink-0"
                aria-label={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="size-5" />
                ) : volume < 0.5 ? (
                  <Volume1 className="size-5" />
                ) : (
                  <Volume2 className="size-5" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                onClick={(e) => e.stopPropagation()}
                aria-label="Volume"
                className={cn(
                  "w-0 opacity-0 group-hover/vol:w-16 group-hover/vol:opacity-100 group-focus-within/vol:w-16 group-focus-within/vol:opacity-100",
                  "transition-all duration-200 cursor-pointer accent-white h-1",
                )}
              />
            </div>

            {/* Time */}
            <span className="text-white text-xs tabular-nums min-w-0">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <div className="flex-1" />

            {/* Fullscreen */}
            <button
              type="button"
              onClick={handleFullscreen}
              className="text-white hover:text-white/80 transition-colors"
              aria-label="Fullscreen"
            >
              <Expand className="size-[18px]" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Save a video to the device from its already-resolved (and, for encrypted
 * media, already-decrypted) source — the `blob:` URL for encrypted / Buzz
 * media, the original `https:` URL otherwise — mirroring the lightbox's own
 * download button so the two behave identically. A cross-origin host without
 * CORS can't be read, so {@link downloadUrl} falls back to opening the file.
 */
async function saveVideo(src: string, ref: { url: string; mime?: string }): Promise<void> {
  try {
    const result = await downloadUrl(src, { nameHint: ref.url, mime: ref.mime });
    toast(
      result === "downloaded"
        ? Capacitor.isNativePlatform()
          ? { title: "Saved", description: "You'll find it in the Armada folder in Files." }
          : { title: "Saved", description: "Check your downloads folder." }
        : {
            title: "Opened in a new tab",
            description: "This video couldn't be saved directly, so it opened instead.",
          },
    );
  } catch {
    toast({
      title: "Download failed",
      description: "Could not save this video. Please try again.",
      variant: "destructive",
    });
  }
}

/** Hand a video to the system share sheet (the file, never the URL). */
async function shareVideo(src: string, ref: { url: string; mime?: string }): Promise<void> {
  const shared = await shareFile(src, { nameHint: ref.url, mime: ref.mime, dialogTitle: "Share video" });
  if (!shared) {
    toast({
      title: "Couldn't share this video",
      description: "Try downloading it instead.",
      variant: "destructive",
    });
  }
}

/** Device-agnostic corner Download button for the current video. */
function VideoDownloadButton({ src, nameHint, mime }: { src: string; nameHint: string; mime?: string }) {
  const [busy, setBusy] = useState(false);

  const handleDownload = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      setBusy(true);
      try {
        await saveVideo(src, { url: nameHint, mime });
      } finally {
        setBusy(false);
      }
    },
    [busy, src, nameHint, mime],
  );

  return (
    <button
      type="button"
      aria-label="Download video"
      title="Download"
      disabled={busy}
      onClick={handleDownload}
      className="size-9 touch:size-11 rounded-full bg-black/60 text-white flex items-center justify-center backdrop-blur-sm hover:bg-black/80 transition-colors disabled:opacity-60 disabled:cursor-wait"
    >
      {busy ? <Loader2 className="size-5 animate-spin" /> : <Download className="size-5" />}
    </button>
  );
}

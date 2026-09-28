import { useEffect, useState } from "react";

/** Longest edge of a generated frame, in pixels; bounds encode cost and string size. */
const MAX_THUMBNAIL_EDGE = 960;

/**
 * Generated frames keyed by {@link ThumbnailSource.identity}; insertion order is
 * LRU order. Bounded by bytes (base64 JPEG length ≈ memory) since size follows resolution.
 */
const THUMBNAIL_CACHE = new Map<string, string>();
const MAX_CACHED_THUMBNAIL_BYTES = 8 * 1024 * 1024;
let cachedThumbnailBytes = 0;

function peekThumbnail(identity: string): string | undefined {
  const hit = THUMBNAIL_CACHE.get(identity);
  if (hit === undefined) return undefined;
  THUMBNAIL_CACHE.delete(identity);
  THUMBNAIL_CACHE.set(identity, hit);
  return hit;
}

function rememberThumbnail(identity: string, dataUrl: string): void {
  const replaced = THUMBNAIL_CACHE.get(identity);
  if (replaced !== undefined) cachedThumbnailBytes -= replaced.length;
  THUMBNAIL_CACHE.set(identity, dataUrl);
  cachedThumbnailBytes += dataUrl.length;
  for (const [key, value] of THUMBNAIL_CACHE) {
    if (cachedThumbnailBytes <= MAX_CACHED_THUMBNAIL_BYTES) break;
    if (key === identity) continue; // never evict the frame we just grabbed
    THUMBNAIL_CACHE.delete(key);
    cachedThumbnailBytes -= value.length;
  }
}

export interface ThumbnailSource {
  /**
   * The resolved playback source: a same-origin `blob:` URL for encrypted media,
   * or the original `https:` URL (a CORS-less host taints the canvas; caller
   * falls back to the blurhash).
   */
  src: string;
  /**
   * Stable cache key for the bytes. Object URLs change per decrypt, so pass the
   * pre-resolution URL. Defaults to `src`.
   */
  identity?: string;
  /** A poster supplied by the sender. Present → nothing is generated at all. */
  poster: string | undefined;
}

/**
 * Grab a thumbnail frame from a video off-screen, mainly for Android WebView
 * where `preload="metadata"` doesn't paint a first frame. HLS is unsupported
 * (chat video is always a Blossom blob or object URL).
 */
export function useVideoThumbnail({ src, identity, poster }: ThumbnailSource): string | undefined {
  // Empty `src` means generation is off; don't report a stale frame for the identity.
  const key = src ? identity || src : "";
  const [thumbnail, setThumbnail] = useState<string | undefined>(
    () => poster ?? (key ? peekThumbnail(key) : undefined),
  );

  useEffect(() => {
    if (poster) {
      setThumbnail(poster);
      return;
    }
    if (!src) return;
    const cached = peekThumbnail(key);
    if (cached) {
      setThumbnail(cached);
      return;
    }

    let cancelled = false;
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = src;

    const captureFrame = () => {
      if (cancelled) return;
      try {
        const width = video.videoWidth || 320;
        const height = video.videoHeight || 180;
        // Callers read the thumbnail's natural size, so preserve the aspect ratio.
        const scale = Math.min(1, MAX_THUMBNAIL_EDGE / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          // A blank / failed capture is a tiny string; only keep a real frame.
          if (dataUrl.length > 1000) {
            rememberThumbnail(key, dataUrl);
            setThumbnail(dataUrl);
          }
        }
      } catch {
        /* CORS or tainted canvas — leave the blurhash in place. */
      }
      video.src = "";
      video.load();
    };

    // Seek slightly in — some encoders paint a black frame at exactly 0.
    const handleMetadata = () => {
      video.currentTime = 0.1;
    };
    const handleSeeked = () => captureFrame();

    video.addEventListener("loadedmetadata", handleMetadata, { once: true });
    video.addEventListener("seeked", handleSeeked, { once: true });

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("seeked", handleSeeked);
      video.src = "";
      video.load();
    };
  }, [src, key, poster]);

  return thumbnail;
}

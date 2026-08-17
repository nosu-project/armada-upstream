import { useEffect, useState } from "react";

/**
 * Longest edge of a generated frame, in pixels.
 *
 * A poster is a placeholder shown until the element paints its own first frame,
 * so it is never the thing being looked at closely — but grabbing at the
 * source's resolution makes both the encode and the string it produces scale
 * with whatever the sender uploaded, and a 4K frame is ~150× the pixels of a
 * 320×180 one. `drawImage` is already scaling into the canvas, so scaling it
 * into a smaller one is what bounds both. Sources under the cap are untouched.
 */
const MAX_THUMBNAIL_EDGE = 960;

/**
 * Generated frames, keyed by {@link ThumbnailSource.identity}. Insertion order
 * is LRU order.
 *
 * A grab is expensive (a decode, then a `toDataURL` JPEG encode, both on the
 * main thread) and its result is deterministic for a given source, so holding
 * it across mounts is what keeps a channel switch from re-paying for every
 * video in the window.
 *
 * Bounded by BYTES, like the decrypted-attachment cache in `@/lib/encryptedMedia`
 * and for the same reason: an entry is a base64 JPEG whose size follows the
 * frame's, so a count would bound the number of strings while leaving their
 * total free to follow whatever resolutions happen to be in the channel. The
 * edge cap above narrows that spread but doesn't close it. Length is a fair
 * proxy for the memory: the entry is pure ASCII, which V8 and JSC both store at
 * one byte per character.
 */
const THUMBNAIL_CACHE = new Map<string, string>();
const MAX_CACHED_THUMBNAIL_BYTES = 8 * 1024 * 1024;
let cachedThumbnailBytes = 0;

function peekThumbnail(identity: string): string | undefined {
  const hit = THUMBNAIL_CACHE.get(identity);
  if (hit === undefined) return undefined;
  // Re-insert at the tail to mark most-recently-used.
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
   * The *resolved* playback source: a same-origin `blob:` object URL for
   * encrypted / Buzz-authed media (decrypted in memory, so the canvas is
   * untainted and the grab succeeds), or the original `https:` URL for plain
   * media (where a cross-origin host without CORS taints the canvas and the
   * grab silently yields nothing — the caller falls back to the blurhash).
   */
  src: string;
  /**
   * A stable name for the BYTES, used as the cache key. `src` is unusable as
   * one for encrypted media: an object URL is minted per decrypt, so it changes
   * every time the attachment cache evicts and refetches, and the frame filed
   * under the old one can never be hit again. Pass the pre-resolution URL,
   * which also lets a fallback source reuse the frame it names the same bytes
   * as. Defaults to `src` for media that has no other identity.
   */
  identity?: string;
  /** A poster supplied by the sender. Present → nothing is generated at all. */
  poster: string | undefined;
}

/**
 * Extracts a thumbnail frame from a video URL by loading it off-screen, drawing
 * the first frame to a canvas, and returning a data URL.
 *
 * This exists mainly for Android WebView, where `preload="metadata"` doesn't
 * render a visible first frame, so a poster-less `<video>` shows nothing until
 * playback. If a `poster` is already supplied, generation is skipped entirely
 * and the poster is returned unchanged.
 *
 * HLS is intentionally unsupported: chat / lightbox video is always a Blossom
 * blob or a decrypted object URL, never an `.m3u8` stream, so pulling in an HLS
 * runtime here would only add dead weight.
 */
export function useVideoThumbnail({ src, identity, poster }: ThumbnailSource): string | undefined {
  // An empty `src` means generation is off (GIF mode, or the source hasn't
  // resolved yet), so it must not report a frame either — the identity alone
  // outlives both of those and would otherwise hand back a stale one.
  const key = src ? identity || src : "";
  const [thumbnail, setThumbnail] = useState<string | undefined>(
    () => poster ?? (key ? peekThumbnail(key) : undefined),
  );

  useEffect(() => {
    // Skip if we already have a poster image, or there's nothing to grab from.
    if (poster) {
      setThumbnail(poster);
      return;
    }
    if (!src) return;
    // A grab costs a decode plus a JPEG encode on the main thread, so a channel
    // switch must not redo one it has already paid for.
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
        // Scale the long edge down to the cap, preserving the aspect ratio —
        // callers read the thumbnail's natural size to size the player.
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

    // After metadata loads, seek slightly in — some encoders paint a black
    // first frame at exactly 0 — then capture once the seek settles.
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

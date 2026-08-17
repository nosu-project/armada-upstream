import { useEffect, useState } from "react";

/**
 * Extracts a thumbnail frame from a video URL by loading it off-screen, drawing
 * the first frame to a canvas, and returning a data URL.
 *
 * This exists mainly for Android WebView, where `preload="metadata"` doesn't
 * render a visible first frame, so a poster-less `<video>` shows nothing until
 * playback. If a `poster` is already supplied, generation is skipped entirely
 * and the poster is returned unchanged.
 *
 * `src` should be the *resolved* playback source: a same-origin `blob:` object
 * URL for encrypted / Buzz-authed media (decrypted in memory, so the canvas is
 * untainted and the grab succeeds), or the original `https:` URL for plain
 * media (where a cross-origin host without CORS taints the canvas and the grab
 * silently yields nothing — the caller falls back to the blurhash).
 *
 * HLS is intentionally unsupported: chat / lightbox video is always a Blossom
 * blob or a decrypted object URL, never an `.m3u8` stream, so pulling in an HLS
 * runtime here would only add dead weight.
 */
export function useVideoThumbnail(src: string, poster: string | undefined): string | undefined {
  const [thumbnail, setThumbnail] = useState<string | undefined>(poster);

  useEffect(() => {
    // Skip if we already have a poster image, or there's nothing to grab from.
    if (poster) {
      setThumbnail(poster);
      return;
    }
    if (!src) return;

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
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 180;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          // A blank / failed capture is a tiny string; only keep a real frame.
          if (dataUrl.length > 1000) setThumbnail(dataUrl);
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
  }, [src, poster]);

  return thumbnail;
}

import { Loader2 } from "lucide-react";
import { useMemo } from "react";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { MediaFallback } from "@/components/chat/MediaFallback";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { isValidBlurhash } from "@/lib/blurhash";
import { companionEncryption } from "@/lib/imeta";
import { cn } from "@/lib/utils";

import type { ImetaEncryption } from "@/lib/imeta";

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
  /**
   * Present as a GIF: autoplay, loop, muted, no controls, transparent chrome.
   * Set for Tenor/Giphy-style `.mp4` renditions that are really animated GIFs.
   */
  gif?: boolean;
  className?: string;
}

/**
 * Inline chat video player. Uses native controls but reserves the correct
 * aspect ratio from imeta `dim` to prevent layout shifts. Encrypted
 * (Concord/Vector) attachments are AES-GCM ciphertext on Blossom, so the src
 * is fetched + decrypted to an object URL before it reaches the <video>.
 */
export function VideoPlayer({ src, poster, dim, blurhash, mime, encryption, fallbacks, gif = false, className }: VideoPlayerProps) {
  const { resolved, onError, failed, fallbackProps } = useMediaWithFallback({ url: src, encryption, mime, fallbacks });

  // An encrypted poster is ciphertext on Blossom, so it has to be fetched and
  // decrypted before the <video> can use it. NIP-17 encrypts a `thumb` with the
  // same key and nonce as its file, so the video's own params decrypt it — but
  // only the key and nonce carry over, not the video's `ox`, which hashes a
  // different blob entirely.
  const posterEncryption = useMemo(() => companionEncryption(encryption), [encryption]);
  const resolvedPoster = useResolvedMediaSrc({
    url: poster ?? "",
    encryption: posterEncryption,
    mime: "image/jpeg",
  });
  const posterSrc = poster && resolvedPoster.status === "ready" ? resolvedPoster.src : undefined;

  const aspectRatio = useMemo(() => {
    const match = dim?.match(/^(\d+)x(\d+)$/);
    if (match) {
      const w = Number.parseInt(match[1], 10);
      const h = Number.parseInt(match[2], 10);
      if (w > 0 && h > 0) return `${w} / ${h}`;
    }
    return "16 / 9";
  }, [dim]);

  if (failed) {
    return <MediaFallback {...fallbackProps} label={gif ? "GIF" : "Video"} />;
  }

  return (
    <div
      className={cn(
        "my-1.5 rounded-xl overflow-hidden",
        // A GIF gets transparent, borderless chrome and image-like sizing; a
        // video keeps its framed black letterbox.
        gif ? "max-w-xs bg-transparent" : "max-w-md border border-border bg-black",
        className,
      )}
      style={{ aspectRatio }}
      onClick={(e) => e.stopPropagation()}
    >
      {resolved.status === "ready" ? (
        <video
          src={resolved.src}
          poster={gif ? undefined : posterSrc}
          controls={!gif}
          autoPlay={gif}
          loop={gif}
          muted={gif}
          disablePictureInPicture={gif}
          preload="metadata"
          playsInline
          className="w-full h-full object-contain"
          onError={onError}
        />
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

import { useImageFallback } from "@/hooks/useBlossomCandidates";

import type { ImgHTMLAttributes, ReactNode } from "react";

interface FallbackImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> {
  /** The image URL, already sanitized by the caller. Nothing renders without one. */
  src: string | undefined;
  /** Rendered once every source has failed. Defaults to nothing. */
  fallback?: ReactNode;
}

/**
 * An `<img>` that walks the same content-addressed blob across the viewer's
 * other Blossom servers before giving up (see `useImageFallback`), then shows
 * `fallback` instead of a broken-image icon.
 *
 * For the images that are not chat attachments — profile banners, badge art,
 * emoji-pack icons — which used to be plain `<img onError={hide}>` elements,
 * each one blank the moment the single server named in its URL went down.
 */
export function FallbackImage({ src, fallback = null, alt = "", ...props }: FallbackImageProps) {
  const walk = useImageFallback(src);
  if (!walk.src || walk.failed) return <>{fallback}</>;
  return <img {...props} src={walk.src} alt={alt} onError={walk.onError} />;
}

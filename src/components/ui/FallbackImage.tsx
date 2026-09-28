import { useImageFallback } from "@/hooks/useBlossomCandidates";

import type { ImgHTMLAttributes, ReactNode } from "react";

interface FallbackImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> {
  /** Already sanitized by the caller. Nothing renders without one. */
  src: string | undefined;
  /** Other URLs for the same image, tried before the viewer's own servers. */
  fallbacks?: readonly string[];
  fallback?: ReactNode;
}

/**
 * `<img>` that walks the blob across the viewer's Blossom servers (see
 * `useImageFallback`) before showing `fallback`. Under the media policy; a
 * gated image renders nothing.
 */
export function FallbackImage({ src, fallbacks, fallback = null, alt = "", ...props }: FallbackImageProps) {
  const walk = useImageFallback(src, fallbacks);
  if (!walk.src || walk.failed) return <>{fallback}</>;
  return <img {...props} src={walk.src} alt={alt} onError={walk.onError} />;
}

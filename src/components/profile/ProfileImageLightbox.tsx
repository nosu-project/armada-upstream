import { useMemo } from "react";

import { Lightbox, type LightboxItem } from "@/components/chat/Lightbox";
import { imetaFor } from "@/lib/profileImeta";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";

import type { ImetaEntry } from "@/lib/imeta";

const NOOP_NAV = () => {};

/**
 * A profile's picture or banner full size, in the chat `Lightbox` so it gets the
 * same media policy, decryption and fallbacks. `imeta` is the kind 0's entry for it.
 */
export function ProfileImageLightbox({
  src,
  imeta,
  onClose,
  className,
}: {
  src: string;
  imeta?: ImetaEntry;
  onClose: () => void;
  className?: string;
}) {
  const media = useMemo<LightboxItem[]>(() => {
    const url = sanitizeImageSrc(src) ?? "";
    const entry = imetaFor(url, imeta);
    return [{
      url,
      encryption: entry?.encryption,
      fallbacks: entry?.fallbacks,
      dim: entry?.dim,
      blurhash: entry?.blurhash,
    }];
  }, [src, imeta]);

  return (
    <Lightbox
      media={media}
      currentIndex={0}
      onClose={onClose}
      onNext={NOOP_NAV}
      onPrev={NOOP_NAV}
      className={className}
    />
  );
}

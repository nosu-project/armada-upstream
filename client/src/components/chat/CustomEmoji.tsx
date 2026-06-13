import { useCallback, useState } from "react";

import { buildEmojiMap } from "@/lib/customEmoji";

import type { ReactNode } from "react";

/** Threshold at or below which we apply nearest-neighbor scaling. */
const PIXEL_ART_MAX = 16;

interface CustomEmojiImgProps {
  /** The shortcode name (without colons). */
  name: string;
  /** The image URL. */
  url: string;
  /** CSS class name for the img element. */
  className?: string;
}

/**
 * Renders a single NIP-30 custom emoji as an inline image.
 *
 * If the image's natural dimensions are 16x16 or smaller, nearest-neighbor
 * (`image-rendering: pixelated`) scaling is applied to preserve crisp pixels.
 */
export function CustomEmojiImg({
  name,
  url,
  className = "inline h-[1.2em] w-[1.2em] object-contain align-text-bottom",
}: CustomEmojiImgProps) {
  const [pixelated, setPixelated] = useState(false);

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalWidth <= PIXEL_ART_MAX && img.naturalHeight <= PIXEL_ART_MAX) {
      setPixelated(true);
    }
  }, []);

  return (
    <img
      src={url}
      alt={`:${name}:`}
      title={`:${name}:`}
      className={className}
      style={pixelated ? { imageRendering: "pixelated" } : undefined}
      loading="lazy"
      decoding="async"
      onLoad={handleLoad}
    />
  );
}

/** Regex matching `:shortcode:` patterns in text. */
const SHORTCODE_REGEX = /:([a-zA-Z0-9_-]+):/g;

/** Replaces `:shortcode:` patterns in text with inline custom emoji images. */
export function emojify(
  text: string,
  emojiMap: Map<string, string>,
  imgClassName?: string,
): ReactNode[] {
  if (emojiMap.size === 0) return [text];

  const result: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  SHORTCODE_REGEX.lastIndex = 0;

  while ((match = SHORTCODE_REGEX.exec(text)) !== null) {
    const [fullMatch, shortcode] = match;
    const url = emojiMap.get(shortcode);

    if (!url) continue;

    if (match.index > lastIndex) {
      result.push(text.substring(lastIndex, match.index));
    }

    result.push(
      <CustomEmojiImg
        key={`emoji-${match.index}`}
        name={shortcode}
        url={url}
        className={imgClassName}
      />,
    );

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    result.push(text.substring(lastIndex));
  }

  return result.length > 0 ? result : [text];
}

interface EmojifiedTextProps {
  /** The text to emojify. */
  children: string;
  /** The event tags to extract emoji definitions from. */
  tags: string[][];
  /** Optional CSS class for the custom emoji images. */
  imgClassName?: string;
}

/** Renders text with NIP-30 custom emoji shortcodes replaced by inline images. */
export function EmojifiedText({ children, tags, imgClassName }: EmojifiedTextProps) {
  const emojiMap = buildEmojiMap(tags);
  if (emojiMap.size === 0) return <>{children}</>;
  return <>{emojify(children, emojiMap, imgClassName)}</>;
}

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { EmojiSourcePopover } from "@/components/chat/EmojiSourcePopover";

import type { ReactNode } from "react";

/** Regex matching `:shortcode:` patterns in text. */
const SHORTCODE_REGEX = /:([a-zA-Z0-9_-]+):/g;

/**
 * Replaces `:shortcode:` patterns in text with inline custom emoji images.
 *
 * When `clickable` is set, each emoji becomes a trigger for its source popover
 * (which pack it came from, with a one-tap add). Left off for compact previews
 * — DM lists, reply quotes, display names — where a tappable popover is noise.
 *
 * `authorPubkey` is who typed the text; the popover uses it to resolve an
 * unknown pack over that author's own relays rather than blindly (see
 * `useEmojiSource`). Harmless to omit — resolution just stays local-only.
 */
export function emojify(
  text: string,
  emojiMap: Map<string, string>,
  imgClassName?: string,
  clickable = false,
  authorPubkey?: string,
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
      clickable ? (
        <EmojiSourcePopover
          key={`emoji-${match.index}`}
          name={shortcode}
          url={url}
          imgClassName={imgClassName}
          authorPubkey={authorPubkey}
        />
      ) : (
        <CustomEmojiImg
          key={`emoji-${match.index}`}
          name={shortcode}
          url={url}
          className={imgClassName}
        />
      ),
    );

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    result.push(text.substring(lastIndex));
  }

  return result.length > 0 ? result : [text];
}

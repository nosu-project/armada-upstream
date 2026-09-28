import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { EmojiSourcePopover } from "@/components/chat/EmojiSourcePopover";

import type { ReactNode } from "react";

const SHORTCODE_REGEX = /:([a-zA-Z0-9_-]+):/g;

/**
 * Replace `:shortcode:` with custom emoji images. `clickable` opens the source
 * pack popover (off for compact previews). `authorPubkey` lets an unknown pack
 * resolve over the author's relays (see `useEmojiSource`).
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

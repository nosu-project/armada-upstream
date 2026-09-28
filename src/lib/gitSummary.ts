/**
 * Plain-text previews for Git bodies in channel rows: one short run of prose
 * plus a media count, so a large issue takes chat-message room. A CSS clamp
 * can't shrink images; the full body renders in the ticket panel.
 */

const IMAGE_URL = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)(?:[?#]|$)/i;
const VIDEO_URL = /\.(?:mp4|webm|mov|m4v|avi|mkv|ogv)(?:[?#]|$)/i;
const AUDIO_URL = /\.(?:mp3|m4a|wav|ogg|oga|opus|flac)(?:[?#]|$)/i;

export interface GitBodyPreview {
  /** Prose only: markdown syntax stripped, whitespace collapsed, truncated. */
  text: string;
  /** Whether {@link text} was cut short. */
  truncated: boolean;
}

/** Reduce a Git body to short prose. `maxChars` bounds the DOM cost, not just what's visible. */
export function gitBodyPreview(content: string, maxChars = 120): GitBodyPreview {
  const isMediaUrl = (url: string): boolean => IMAGE_URL.test(url) || VIDEO_URL.test(url) || AUDIO_URL.test(url);

  let text = content.replace(/\r\n?/g, "\n");
  // Drop HTML comments and media tags.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<video\b[\s\S]*?(?:<\/video>|\/?>)/gi, " ");
  text = text.replace(/<\/?[a-z][^>]*>/gi, " ");
  // All markdown images go: upload hosts often use extensionless paths.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Bare media URLs go; other URLs are often the point of a comment.
  text = text.replace(/https?:\/\/\S+/gi, (url) => (isMediaUrl(url) ? " " : url));
  // Drop fence markers but keep contents, so a stack trace previews as its first lines.
  text = text.replace(/^[ \t]*(?:```|~~~).*$/gm, " ");
  // Line-leading structure: quotes, headings, bullets, ordered markers.
  text = text.replace(/^[ \t]*(?:>[ \t]*)+/gm, "");
  text = text.replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "");
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, " ");
  text = text.replace(/^[ \t]*\|?[ \t:|-]{3,}\|?[ \t]*$/gm, " ");
  // Paired markers only, so snake_case survives.
  text = text.replace(/\*\*|__|~~|`+/g, "");
  text = text.replace(/\s+/g, " ").trim();

  const truncated = text.length > maxChars;
  if (truncated) {
    const cut = text.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    text = `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }

  return { text, truncated };
}

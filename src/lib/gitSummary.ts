/**
 * Plain-text previews for Git bodies rendered inside a channel.
 *
 * A channel row is a REFERENCE to a work item, not the work item itself. An
 * issue whose body is three screenshots, a screen recording and a 400-line
 * stack trace has to take about as much room as a chat message, or it drowns
 * the conversation it is meant to sit beside. The full body — markdown, media,
 * embeds — renders in the ticket panel, which is what the row opens.
 *
 * So a body is reduced to one short run of prose plus a COUNT of the media it
 * dropped, rather than clamped as rendered markup: a line clamp cannot shorten
 * an image, and `ChatContent` deliberately ignores `clampLines` the moment
 * block media is present.
 *
 * The reduction is lossy on purpose and is never the only way to read a body.
 */

const IMAGE_URL = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|heic|heif)(?:[?#]|$)/i;
const VIDEO_URL = /\.(?:mp4|webm|mov|m4v|avi|mkv|ogv)(?:[?#]|$)/i;
const AUDIO_URL = /\.(?:mp3|m4a|wav|ogg|oga|opus|flac)(?:[?#]|$)/i;

export interface GitBodyPreview {
  /** Prose only: markdown syntax stripped, whitespace collapsed, truncated. */
  text: string;
  /** Whether {@link text} was cut short — the row owes the reader a way in. */
  truncated: boolean;
}

/**
 * Reduce a Git body to a couple of lines of prose, dropping the media.
 *
 * `maxChars` bounds the string itself rather than relying on a CSS clamp: the
 * clamp keeps the row short on screen, but a megabyte of text still costs a
 * megabyte of DOM to lay out and hit-test behind it. The default is short
 * enough that the row commits to about two lines and hands the rest over.
 */
export function gitBodyPreview(content: string, maxChars = 120): GitBodyPreview {
  /** Drop a URL that renders as media, or report that it is ordinary prose. */
  const isMediaUrl = (url: string): boolean => IMAGE_URL.test(url) || VIDEO_URL.test(url) || AUDIO_URL.test(url);

  let text = content.replace(/\r\n?/g, "\n");
  // Raw HTML: comments say nothing to a reader, and a media tag is media
  // however it was spelled.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<video\b[\s\S]*?(?:<\/video>|\/?>)/gi, " ");
  text = text.replace(/<\/?[a-z][^>]*>/gi, " ");
  // Every markdown image goes, whatever its URL looks like — most upload
  // hosts serve content-addressed paths with no extension to recognize.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  // A link's label is the prose; its target is not.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Bare media URLs render as players in the panel, so they go here too.
  // Other URLs stay: they are often the whole point of a comment.
  text = text.replace(/https?:\/\/\S+/gi, (url) => (isMediaUrl(url) ? " " : url));
  // Fence markers go and their contents stay: a body that is only a stack
  // trace should preview as its first lines rather than as nothing at all.
  text = text.replace(/^[ \t]*(?:```|~~~).*$/gm, " ");
  // Line-leading structure: quotes, headings, bullets, ordered markers.
  text = text.replace(/^[ \t]*(?:>[ \t]*)+/gm, "");
  text = text.replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "");
  // Thematic breaks and table rules, which collapse to punctuation noise.
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, " ");
  text = text.replace(/^[ \t]*\|?[ \t:|-]{3,}\|?[ \t]*$/gm, " ");
  // Paired inline markers only. A lone `*` or `_` is left alone so that
  // snake_case identifiers survive, which matters in exactly this content.
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

/**
 * Minimal Discord-flavored markdown parsing for chat messages.
 *
 * Pure parsing only (no React) — rendering lives in
 * `components/chat/Markdown.tsx`. The dialect is the chat-safe subset Discord
 * uses:
 *
 * - Blocks: fenced code (```lang … ```), quotes (lines starting with `> `),
 *   headings (`# `, `## `, `### ` — three levels, as in Discord), and flat
 *   ordered/unordered lists (`- item`, `1. item`).
 * - Inline: `**bold**`, `*italic*` / `_italic_`, `__underline__`,
 *   `~~strikethrough~~`, `||spoiler||`, and `` `inline code` ``.
 *
 * Document mode (long-form git content) widens this to GitHub's dialect:
 * heading levels 4–6 and `[text](url)` links.
 *
 * Block splitting runs BEFORE the URL/nostr tokenizer so nothing inside code
 * is linkified; inline formatting is applied at render time to plain-text
 * tokens only, so links/mentions/custom-emoji keep their existing handling.
 */

/** A top-level block of message content. */
export type MdBlock =
  | { type: "code"; lang?: string; code: string }
  | { type: "quote"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; start: number; items: string[] }
  | { type: "text"; text: string };

/** A segment of a text run, either plain or inline code. */
export type InlineCodeSegment = { code: boolean; value: string };

/** An inline formatting AST node. */
export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong" | "em" | "u" | "s" | "spoiler"; children: InlineNode[] };

/** Fenced code block: ```lang\n … ``` (closing fence required). */
const FENCE_RE = /```([\w+-]*)\n?([\s\S]*?)```/g;

/** A quote line: `> text` (or a bare `>`), Discord-style. */
const QUOTE_LINE_RE = /^>\s?/;

/**
 * Split message text into top-level blocks: fenced code, quote runs
 * (consecutive `> ` lines merged into one block, markers stripped), ATX
 * headings, flat ordered/unordered list runs, and plain text (newlines
 * preserved). Chat recognizes heading levels 1–3 like Discord; with `document`
 * set, levels 4–6 also split out for long-form GitHub-flavored git content.
 */
export function splitMarkdownBlocks(src: string, document = false): MdBlock[] {
  const blocks: MdBlock[] = [];
  let last = 0;
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(src)) !== null) {
    if (m.index > last) blocks.push(...splitQuoteBlocks(src.slice(last, m.index), document));
    const code = m[2].replace(/\n$/, "");
    if (code.trim() !== "") {
      blocks.push({ type: "code", lang: m[1] || undefined, code });
    } else {
      // An empty fence is almost certainly not intentional code — keep it literal.
      blocks.push({ type: "text", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) blocks.push(...splitQuoteBlocks(src.slice(last), document));
  return blocks;
}

/** Split a non-code chunk into quote blocks (runs of `> ` lines) and text. */
function splitQuoteBlocks(src: string, document = false): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.split("\n");
  let textLines: string[] = [];
  let quoteLines: string[] | null = null;

  const flushText = () => {
    if (textLines.length > 0) {
      const text = textLines.join("\n");
      if (text !== "") blocks.push(...splitHeadingListBlocks(text, document));
      textLines = [];
    }
  };
  const flushQuote = () => {
    if (quoteLines) {
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      quoteLines = null;
    }
  };

  for (const line of lines) {
    if (QUOTE_LINE_RE.test(line)) {
      flushText();
      (quoteLines ??= []).push(line.replace(QUOTE_LINE_RE, ""));
    } else {
      flushQuote();
      textLines.push(line);
    }
  }
  flushText();
  flushQuote();
  return blocks;
}

/** ATX heading: `## text` (1-6 hashes, space required so `#hashtag` stays literal). */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
/** Deepest heading level chat recognizes (`# `, `## `, `### `, as in Discord). */
const CHAT_HEADING_MAX_LEVEL = 3;
/** Unordered list item: `- text` (space required so `*italic*` stays literal). */
const UNORDERED_ITEM_RE = /^\s{0,3}[-*+]\s+(.+)$/;
/** Ordered list item: `1. text` / `1) text`. */
const ORDERED_ITEM_RE = /^\s{0,3}(\d{1,9})[.)]\s+(.+)$/;

/**
 * Split a text chunk into headings, flat list runs and remaining text.
 *
 * Chat stops at heading level 3 (`####` stays literal, as in Discord); document
 * mode takes all six. Boundary newlines next to an extracted block fold into
 * that block's margin — in chat only when something was actually extracted, so
 * a chunk without headings or lists passes through byte-for-byte as before.
 */
function splitHeadingListBlocks(src: string, document: boolean): MdBlock[] {
  const blocks: MdBlock[] = [];
  const maxHeading = document ? 6 : CHAT_HEADING_MAX_LEVEL;
  let textLines: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushText = () => {
    if (textLines.length > 0) {
      // One boundary newline each side folds into the neighbor block's margin.
      const text = textLines.join("\n").replace(/^\n/, "").replace(/\n$/, "");
      if (text !== "") blocks.push({ type: "text", text });
      textLines = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: "list", ...list });
      list = null;
    }
  };

  for (const line of src.split("\n")) {
    const heading = HEADING_RE.exec(line);
    if (heading && heading[1].length <= maxHeading) {
      flushText();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const ordered = ORDERED_ITEM_RE.exec(line);
    const unordered = ordered ? null : UNORDERED_ITEM_RE.exec(line);
    if (ordered || unordered) {
      flushText();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flushList();
      if (!list) list = { ordered: isOrdered, start: ordered ? parseInt(ordered[1], 10) : 1, items: [] };
      list.items.push((ordered?.[2] ?? unordered![1]).trim());
      continue;
    }
    flushList();
    textLines.push(line);
  }
  flushText();
  flushList();
  if (!document && blocks.every((b) => b.type === "text")) {
    return [{ type: "text", text: src }];
  }
  return blocks;
}

/** A segment of a text run, either plain or a `[text](url)` markdown link. */
export type MdLinkSegment =
  | { type: "text"; value: string }
  | { type: "link"; text: string; url: string };

/** `[text](url)` / `![alt](url)`, http(s) only so pseudo-scheme URLs stay literal. */
const MD_LINK_RE = /(!?)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * Split a text run on markdown links. Image syntax (`![alt](url)`) yields the
 * bare URL as text so the media tokenizer embeds it like any pasted image URL.
 */
export function splitMarkdownLinks(src: string): MdLinkSegment[] {
  const out: MdLinkSegment[] = [];
  let last = 0;
  MD_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ type: "text", value: src.slice(last, m.index) });
    if (m[1]) out.push({ type: "text", value: m[3] });
    else out.push({ type: "link", text: m[2], url: m[3] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: "text", value: src.slice(last) });
  return out;
}

/** Inline code span: `code` (no newlines, non-empty). */
const INLINE_CODE_RE = /`([^`\n]+)`/g;

/**
 * Split a text run into plain segments and `` `inline code` `` segments so the
 * URL/nostr tokenizer can skip code.
 */
export function splitInlineCode(src: string): InlineCodeSegment[] {
  const out: InlineCodeSegment[] = [];
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ code: false, value: src.slice(last, m.index) });
    out.push({ code: true, value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ code: false, value: src.slice(last) });
  return out;
}

/**
 * Inline formatting patterns, in tie-break priority order (longer delimiters
 * first so `**bold**` beats `*italic*` at the same index).
 */
const INLINE_PATTERNS: ReadonlyArray<{
  type: Exclude<InlineNode["type"], "text">;
  re: RegExp;
}> = [
  // Closing delimiters carry a negative lookahead so `**bold *and italic***`
  // closes at the LAST `**` (the lazy match would otherwise strand a `*`).
  { type: "strong", re: /\*\*([\s\S]+?)\*\*(?!\*)/ },
  { type: "u", re: /__([\s\S]+?)__(?!_)/ },
  { type: "s", re: /~~([\s\S]+?)~~(?!~)/ },
  { type: "spoiler", re: /\|\|([\s\S]+?)\|\|(?!\|)/ },
  { type: "em", re: /\*([^*\n]+)\*(?!\*)/ },
  // `_italic_` only at word boundaries so snake_case stays literal.
  { type: "em", re: /(?<![\w])_([^_\n]+)_(?![\w])/ },
];

/**
 * Parse inline formatting into an AST. Unmatched/degenerate delimiters (e.g.
 * whitespace-only content) stay literal text. Nesting is supported
 * (`**bold *and italic***` → strong > em).
 */
export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let rest = text;

  while (rest.length > 0) {
    let best: { index: number; length: number; content: string; type: Exclude<InlineNode["type"], "text"> } | null = null;
    for (const { type, re } of INLINE_PATTERNS) {
      const m = re.exec(rest);
      if (!m) continue;
      if (m[1].trim() === "") continue; // "** **" etc. stays literal
      if (!best || m.index < best.index) {
        best = { index: m.index, length: m[0].length, content: m[1], type };
      }
    }
    if (!best) {
      out.push({ type: "text", value: rest });
      break;
    }
    if (best.index > 0) out.push({ type: "text", value: rest.slice(0, best.index) });
    out.push({ type: best.type, children: parseInline(best.content) });
    rest = rest.slice(best.index + best.length);
  }

  return out;
}

/** Whether a text run contains any inline formatting worth parsing. */
export function hasInlineMarkdown(text: string): boolean {
  return /\*|__|~~|\|\|/.test(text) || /(?<![\w])_[^_\n]+_(?![\w])/.test(text);
}

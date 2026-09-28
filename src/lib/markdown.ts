/**
 * Discord-flavored markdown parsing for chat (rendering: `components/chat/Markdown.tsx`).
 * Document mode (git content) adds heading levels 4–6 and `[text](url)` links.
 * Blocks are split BEFORE the URL/nostr tokenizer so code isn't linkified.
 */

/** A top-level block of message content. */
export type MdBlock =
  | { type: "code"; lang?: string; code: string }
  | { type: "quote"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; start: number; items: string[] }
  | { type: "text"; text: string };

export type InlineCodeSegment = { code: boolean; value: string };

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong" | "em" | "u" | "s" | "spoiler"; children: InlineNode[] };

/** Fenced code block: ```lang\n … ``` (closing fence required). */
const FENCE_RE = /```([\w+-]*)\n?([\s\S]*?)```/g;

/** A quote line: `> text` (or a bare `>`), Discord-style. */
const QUOTE_LINE_RE = /^>\s?/;

/**
 * Split text into top-level blocks: fenced code, merged quote runs, ATX headings,
 * flat lists, and plain text. Chat headings stop at level 3; `document` allows 4–6.
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
 * Split into headings, flat list runs and remaining text. Boundary newlines fold
 * into the extracted block's margin; chunks without blocks pass through unchanged.
 */
function splitHeadingListBlocks(src: string, document: boolean): MdBlock[] {
  const blocks: MdBlock[] = [];
  const maxHeading = document ? 6 : CHAT_HEADING_MAX_LEVEL;
  let textLines: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushText = () => {
    if (textLines.length > 0) {
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

export type MdLinkSegment =
  | { type: "text"; value: string }
  | { type: "link"; text: string; url: string };

/** `[text](url)` / `![alt](url)`, http(s) only so pseudo-scheme URLs stay literal. */
const MD_LINK_RE = /(!?)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Split on markdown links. `![alt](url)` yields the bare URL so it embeds like a pasted image. */
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

const INLINE_CODE_RE = /`([^`\n]+)`/g;

/** Split out `` `inline code` `` so the URL/nostr tokenizer can skip it. */
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

/** Inline patterns in tie-break priority order (longer delimiters first). */
const INLINE_PATTERNS: ReadonlyArray<{
  type: Exclude<InlineNode["type"], "text">;
  re: RegExp;
}> = [
  // Negative lookahead so `**bold *and italic***` closes at the LAST `**`.
  { type: "strong", re: /\*\*([\s\S]+?)\*\*(?!\*)/ },
  { type: "u", re: /__([\s\S]+?)__(?!_)/ },
  { type: "s", re: /~~([\s\S]+?)~~(?!~)/ },
  { type: "spoiler", re: /\|\|([\s\S]+?)\|\|(?!\|)/ },
  { type: "em", re: /\*([^*\n]+)\*(?!\*)/ },
  // `_italic_` only at word boundaries so snake_case stays literal.
  { type: "em", re: /(?<![\w])_([^_\n]+)_(?![\w])/ },
];

/** Parse inline formatting into an AST; degenerate delimiters stay literal. */
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

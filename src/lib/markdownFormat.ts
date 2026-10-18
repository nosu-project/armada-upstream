/**
 * Toolbar/shortcut formatting for the composer: toggle a markdown wrapper (or
 * line prefix) around a selection, in the dialect `markdown.ts` renders.
 */

export type FormatKind = "bold" | "italic" | "underline" | "strike" | "code" | "spoiler" | "quote";

export interface FormatResult {
  text: string;
  /** The new selection, covering the same content without its markers. */
  start: number;
  end: number;
}

interface InlineSpec {
  char: string;
  /** Markers this format adds and removes on each side. */
  size: number;
  /** Whether runs of `left`/`right` marker characters already apply it. */
  has: (left: number, right: number) => boolean;
}

// `*` carries both: a run of 2 is bold, 1 italic, 3 both.
const INLINE: Record<Exclude<FormatKind, "quote">, InlineSpec> = {
  bold: { char: "*", size: 2, has: (l, r) => Math.min(l, r) >= 2 },
  italic: { char: "*", size: 1, has: (l, r) => Math.min(l, r) % 2 === 1 },
  underline: { char: "_", size: 2, has: (l, r) => Math.min(l, r) >= 2 },
  strike: { char: "~", size: 2, has: (l, r) => Math.min(l, r) >= 2 },
  spoiler: { char: "|", size: 2, has: (l, r) => Math.min(l, r) >= 2 },
  code: { char: "`", size: 1, has: (l, r) => Math.min(l, r) >= 1 },
};

function runBefore(text: string, pos: number, ch: string): number {
  let n = 0;
  while (pos - n - 1 >= 0 && text[pos - n - 1] === ch) n++;
  return n;
}

function runAfter(text: string, pos: number, ch: string): number {
  let n = 0;
  while (pos + n < text.length && text[pos + n] === ch) n++;
  return n;
}

/** Selection shrunk past surrounding whitespace: `** bold**` does not render. */
function trimmed(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

type Wrap = { at: "outside"; s: number; e: number } | { at: "inside" } | null;

const MARKER_CHARS = "*_~|`";

/**
 * Where `spec`'s markers sit outside `[s, e)`, looking past other formats'
 * marker runs wrapped around it (`***~~x~~***` is bold around strike).
 */
function outerWrap(text: string, s: number, e: number, spec: InlineSpec): [number, number] | null {
  for (;;) {
    if (spec.has(runBefore(text, s, spec.char), runAfter(text, e, spec.char))) return [s, e];
    const ch = text[s - 1];
    if (!ch || ch === spec.char || !MARKER_CHARS.includes(ch) || text[e] !== ch) return null;
    const left = runBefore(text, s, ch);
    const right = runAfter(text, e, ch);
    if (left !== right) return null;
    s -= left;
    e += right;
  }
}

function wrapOf(text: string, start: number, end: number, spec: InlineSpec): Wrap {
  const [s, e] = trimmed(text, start, end);
  const outer = outerWrap(text, s, e, spec);
  if (outer) return { at: "outside", s: outer[0], e: outer[1] };
  if (e - s >= spec.size * 2) {
    const inner = runAfter(text, s, spec.char);
    const innerEnd = runBefore(text, e, spec.char);
    // Not a selection that is nothing but markers.
    if (inner < e - s && spec.has(inner, innerEnd)) return { at: "inside" };
  }
  return null;
}

function toggleInlineRange(text: string, start: number, end: number, spec: InlineSpec): FormatResult {
  const [s, e] = trimmed(text, start, end);
  const marker = spec.char.repeat(spec.size);
  const wrap = wrapOf(text, start, end, spec);
  if (wrap?.at === "outside") {
    return {
      text: text.slice(0, wrap.s - spec.size) + text.slice(wrap.s, wrap.e) + text.slice(wrap.e + spec.size),
      start: s - spec.size,
      end: e - spec.size,
    };
  }
  if (wrap?.at === "inside") {
    return {
      text: text.slice(0, s) + text.slice(s + spec.size, e - spec.size) + text.slice(e),
      start: s,
      end: e - spec.size * 2,
    };
  }
  if (s === e) {
    // Nothing (or only whitespace) selected: an empty pair with the caret inside.
    return { text: text.slice(0, end) + marker + marker + text.slice(end), start: end + spec.size, end: end + spec.size };
  }
  return {
    text: text.slice(0, s) + marker + text.slice(s, e) + marker + text.slice(e),
    start: s + spec.size,
    end: e + spec.size,
  };
}

interface Line {
  start: number;
  end: number;
}

function linesOf(text: string, start: number, end: number): Line[] {
  const first = text.lastIndexOf("\n", start - 1) + 1;
  const lines: Line[] = [];
  let pos = first;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    lines.push({ start: pos, end: lineEnd });
    if (nl < 0 || nl >= end || (nl + 1 === end && end > start)) break;
    pos = nl + 1;
  }
  return lines;
}

/** Apply an edit per line, back to front so earlier offsets stay valid. */
function perLine(
  text: string,
  start: number,
  end: number,
  edit: (text: string, line: Line) => { text: string; delta: number; lead: number },
  lines: Line[],
): FormatResult {
  let out = text;
  let newStart = start;
  let newEnd = end;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const { text: next, delta, lead } = edit(out, line);
    out = next;
    newEnd += delta;
    // The first line's leading change shifts the selection start too.
    if (i === 0 && start >= line.start) newStart = Math.max(line.start, newStart + lead);
  }
  return { text: out, start: newStart, end: Math.max(newStart, newEnd) };
}

const QUOTE_RE = /^>>> |^> ?/;

function toggleQuote(text: string, start: number, end: number): FormatResult {
  const lines = linesOf(text, start, end);
  const quoted = lines.every((l) => QUOTE_RE.test(text.slice(l.start, l.end)));
  return perLine(text, start, end, (cur, line) => {
    const body = cur.slice(line.start, line.end);
    if (quoted) {
      const prefix = body.match(QUOTE_RE)![0].length;
      return { text: cur.slice(0, line.start) + cur.slice(line.start + prefix), delta: -prefix, lead: -prefix };
    }
    return { text: `${cur.slice(0, line.start)}> ${cur.slice(line.start)}`, delta: 2, lead: 2 };
  }, lines);
}

const FENCE = "```";

function toggleCodeBlock(text: string, start: number, end: number): FormatResult {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (/(^|\n)```[^\n]*\n$/.test(before) && /^\n```(\n|$)/.test(after)) {
    const open = before.length - before.lastIndexOf("\n", before.length - 2) - 1;
    return {
      text: before.slice(0, before.length - open) + text.slice(start, end) + after.slice(FENCE.length + 1),
      start: start - open,
      end: end - open,
    };
  }
  const lead = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
  const trail = end < text.length && text[end] !== "\n" ? "\n" : "";
  const open = `${lead}${FENCE}\n`;
  return {
    text: `${before}${open}${text.slice(start, end)}\n${FENCE}${trail}${after}`,
    start: start + open.length,
    end: end + open.length,
  };
}

/** Toggle `kind` on `[start, end)` of `text`. */
export function toggleFormat(text: string, start: number, end: number, kind: FormatKind): FormatResult {
  if (kind === "quote") return toggleQuote(text, start, end);
  const selected = text.slice(start, end);
  if (kind === "code" && selected.includes("\n")) return toggleCodeBlock(text, start, end);
  const spec = INLINE[kind];
  if (!selected.includes("\n")) return toggleInlineRange(text, start, end, spec);

  // Inline markers don't cross lines: wrap (or unwrap) each non-blank line.
  const lines = linesOf(text, start, end)
    .map((l) => ({ start: Math.max(l.start, start), end: Math.min(l.end, end) }))
    .filter((l) => text.slice(l.start, l.end).trim() !== "");
  const allWrapped = lines.length > 0 && lines.every((l) => wrapOf(text, l.start, l.end, spec) !== null);
  return perLine(text, start, end, (cur, line) => {
    const wrapped = wrapOf(cur, line.start, line.end, spec) !== null;
    if (wrapped !== allWrapped) return { text: cur, delta: 0, lead: 0 };
    const r = toggleInlineRange(cur, line.start, line.end, spec);
    const [s] = trimmed(cur, line.start, line.end);
    return { text: r.text, delta: r.text.length - cur.length, lead: s === line.start ? r.start - s : 0 };
  }, lines);
}

/** Which formats already apply to the selection, for the toolbar's pressed state. */
export function activeFormats(text: string, start: number, end: number): Set<FormatKind> {
  const out = new Set<FormatKind>();
  if (start === end) return out;
  const lines = linesOf(text, start, end);
  if (lines.every((l) => QUOTE_RE.test(text.slice(l.start, l.end)))) out.add("quote");
  if (text.slice(start, end).includes("\n")) return out;
  for (const kind of Object.keys(INLINE) as Array<keyof typeof INLINE>) {
    if (wrapOf(text, start, end, INLINE[kind])) out.add(kind);
  }
  return out;
}

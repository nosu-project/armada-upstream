import { nip19 } from "nostr-tools";

/**
 * The composer edits a DISPLAY string in which each NIP-27 profile reference
 * (`nostr:npub1…`, `nostr:nprofile1…`) reads as `@Name` and each known NIP-30
 * `:shortcode:` as one placeholder the overlay draws the image over, while the
 * draft, the send path and every tag builder keep the CANONICAL text. This
 * module maps edits and positions between the two; an atom is indivisible in
 * the display.
 */

export interface AtomSpan {
  /** A mention's profile. */
  pubkey?: string;
  /** A custom emoji. */
  emoji?: { shortcode: string; url: string };
  /** `[cStart, cEnd)` in the canonical text. */
  cStart: number;
  cEnd: number;
  /** `[dStart, dEnd)` in the display text. */
  dStart: number;
  dEnd: number;
}

export interface DisplayModel {
  canonical: string;
  display: string;
  /** In document order, non-overlapping. */
  atoms: AtomSpan[];
}

const BECH32_CHAR = /[023456789acdefghjklmnpqrstuvwxyz]/i;
// Greedy and case-insensitive like ChatContent's SEGMENT_RE, so a reference the
// timeline would not render as a mention is not shown as one here either.
const MENTION_RE = /nostr:(npub1|nprofile1)([023456789acdefghjklmnpqrstuvwxyz]+)/gi;
const FENCE_LINE_RE = /^\s*(```|~~~)/;
const INLINE_CODE_RE = /(?<=(?:^|[^\\])(?:\\\\)*)`([^`\n]+)`/g;
const MAX_LABEL = 40;
const SHORTCODE_RE = /:([A-Za-z0-9_+-]+):/g;
/**
 * Stands in for a custom emoji in the textarea: one UTF-16 unit with emoji
 * presentation, so it takes an emoji's width and the image drawn over it fits.
 */
export const EMOJI_PLACEHOLDER = "\u2B1C";

/** `[start, end)` ranges of fenced blocks and inline code, where a reference stays literal. */
export function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let offset = 0;
  let fenceStart = -1;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    if (FENCE_LINE_RE.test(line)) {
      if (fenceStart < 0) fenceStart = offset;
      else {
        out.push([fenceStart, end]);
        fenceStart = -1;
      }
    } else if (fenceStart < 0) {
      INLINE_CODE_RE.lastIndex = 0;
      for (const m of line.matchAll(INLINE_CODE_RE)) {
        out.push([offset + m.index, offset + m.index + m[0].length]);
      }
    }
    offset = end + 1;
  }
  if (fenceStart >= 0) out.push([fenceStart, text.length]);
  return out;
}

const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function mentionLabel(name: string | undefined, pubkey: string): string {
  // Bidi controls would reorder the user's own text after the label.
  const clean = (name ?? "").replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim();
  if (!clean) {
    const npub = nip19.npubEncode(pubkey);
    return `@${npub.slice(0, 10)}…${npub.slice(-4)}`;
  }
  return `@${clean.length > MAX_LABEL ? `${clean.slice(0, MAX_LABEL - 1)}…` : clean}`;
}

function decodeMention(prefix: string, data: string): string | undefined {
  try {
    const decoded = nip19.decode(`${prefix.toLowerCase()}${data.toLowerCase()}`);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    // Not valid bech32: stays literal text.
  }
  return undefined;
}

/** The pubkeys referenced as mentions in `canonical`. */
export function mentionedPubkeys(canonical: string): string[] {
  const pubkeys = buildDisplayModel(canonical, () => "").atoms.map((m) => m.pubkey);
  return [...new Set(pubkeys.filter((pk): pk is string => !!pk))];
}

type Found = { start: number; end: number; label: string } & Pick<AtomSpan, "pubkey" | "emoji">;

export function buildDisplayModel(
  canonical: string,
  labelFor: (pubkey: string) => string,
  emojiUrl?: (shortcode: string) => string | undefined,
): DisplayModel {
  const mayMention = canonical.includes("nostr:");
  const mayEmoji = !!emojiUrl && canonical.includes(":");
  if (!mayMention && !mayEmoji) return { canonical, display: canonical, atoms: [] };
  const code = codeRanges(canonical);
  const inCode = (pos: number) => code.some(([s, e]) => pos >= s && pos < e);
  const found: Found[] = [];
  if (mayMention) {
    for (const m of canonical.matchAll(MENTION_RE)) {
      if (inCode(m.index)) continue;
      const pubkey = decodeMention(m[1], m[2]);
      if (!pubkey) continue;
      const label = labelFor(pubkey) || mentionLabel(undefined, pubkey);
      found.push({ start: m.index, end: m.index + m[0].length, label, pubkey });
    }
  }
  if (mayEmoji) {
    for (const m of canonical.matchAll(SHORTCODE_RE)) {
      const url = emojiUrl(m[1]);
      if (!url || inCode(m.index)) continue;
      found.push({ start: m.index, end: m.index + m[0].length, label: EMOJI_PLACEHOLDER, emoji: { shortcode: m[1], url } });
    }
  }
  found.sort((a, b) => a.start - b.start);

  const atoms: AtomSpan[] = [];
  let display = "";
  let last = 0;
  for (const f of found) {
    if (f.start < last) continue;
    display += canonical.slice(last, f.start);
    const dStart = display.length;
    display += f.label;
    atoms.push({ pubkey: f.pubkey, emoji: f.emoji, cStart: f.start, cEnd: f.end, dStart, dEnd: display.length });
    last = f.end;
  }
  display += canonical.slice(last);
  return { canonical, display, atoms };
}

/**
 * Display offset → canonical offset. A position strictly inside an atom snaps
 * to its start or end per `bias`.
 */
export function toCanonical(model: DisplayModel, pos: number, bias: "start" | "end" = "end"): number {
  let shift = 0;
  for (const m of model.atoms) {
    if (pos <= m.dStart) break;
    if (pos < m.dEnd) return bias === "start" ? m.cStart : m.cEnd;
    shift = m.cEnd - m.dEnd;
  }
  return pos + shift;
}

/** Canonical offset → display offset, with the same snapping as {@link toCanonical}. */
export function toDisplay(model: DisplayModel, pos: number, bias: "start" | "end" = "end"): number {
  let shift = 0;
  for (const m of model.atoms) {
    if (pos <= m.cStart) break;
    if (pos < m.cEnd) return bias === "start" ? m.dStart : m.dEnd;
    shift = m.dEnd - m.cEnd;
  }
  return pos + shift;
}

/** The atom whose display range contains `pos` strictly inside, if any. */
function mentionInside(model: DisplayModel, pos: number): AtomSpan | undefined {
  return model.atoms.find((m) => pos > m.dStart && pos < m.dEnd);
}

/**
 * The single changed range between two strings: `[start, end)` of `prev`
 * replaced by `inserted`. `caret` (the selection end after the edit) pins
 * the range where the change sits inside a run of identical characters.
 */
export function diffRange(
  prev: string,
  next: string,
  caret?: number,
): { start: number; end: number; inserted: string } {
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p++;
  if (caret !== undefined) p = Math.min(p, Math.max(0, caret - Math.max(0, next.length - prev.length)));
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  if (caret !== undefined) s = Math.min(s, Math.max(0, next.length - caret));
  return { start: p, end: prev.length - s, inserted: next.slice(p, next.length - s) };
}

export interface CanonicalEdit {
  canonical: string;
  /** Canonical caret after the edit. */
  caret: number;
}

/**
 * Replace display `[start, end)` with `inserted` (canonical text, so it may
 * itself carry `nostr:` references). A deletion touching a mention removes all
 * of it; an insertion inside one lands after it. A mention wholly inside the
 * replaced range survives where `inserted` still spells its label, which is
 * what keeps undo/redo from flattening mentions into plain text. `keepLabels:
 * false` turns that off for text from outside (a paste or drop), whose `@Name`
 * names nobody: a label is a profile's own choice, so it could keep anyone.
 */
export function spliceDisplay(
  model: DisplayModel,
  start: number,
  end: number,
  inserted: string,
  opts?: { keepLabels?: boolean },
): CanonicalEdit {
  let a = start;
  let b = end;
  if (a === b) {
    const inside = mentionInside(model, a);
    if (inside) a = b = inside.dEnd;
  } else {
    const left = mentionInside(model, a);
    if (left) a = left.dStart;
    const right = mentionInside(model, b);
    if (right) b = right.dEnd;
  }

  let replacement = "";
  let cursor = 0;
  for (const m of opts?.keepLabels === false ? [] : model.atoms) {
    if (m.dStart < a || m.dEnd > b) continue;
    const label = model.display.slice(m.dStart, m.dEnd);
    const at = inserted.indexOf(label, cursor);
    if (at < 0) continue;
    replacement += inserted.slice(cursor, at) + model.canonical.slice(m.cStart, m.cEnd);
    cursor = at + label.length;
  }
  replacement += inserted.slice(cursor);

  const cA = toCanonical(model, a, "start");
  const cB = toCanonical(model, b, "end");
  // Text typed flush against a mention would extend its bech32 and unmake it.
  if (replacement && BECH32_CHAR.test(replacement[0]) && model.atoms.some((m) => m.pubkey && m.cEnd === cA)) {
    replacement = ` ${replacement}`;
  }
  return {
    canonical: model.canonical.slice(0, cA) + replacement + model.canonical.slice(cB),
    caret: cA + replacement.length,
  };
}

/** Map a whole new display value (a user edit) back onto the canonical text. */
export function applyDisplayEdit(
  model: DisplayModel,
  nextDisplay: string,
  caret?: number,
  opts?: { keepLabels?: boolean },
): CanonicalEdit {
  const { start, end, inserted } = diffRange(model.display, nextDisplay, caret);
  return spliceDisplay(model, start, end, inserted, opts);
}

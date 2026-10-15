import {
  decryptAttachmentToObjectURL,
  fetchCapped,
  peekPrimedAttachment,
} from "@/lib/encryptedMedia";

import type { ImetaEncryption } from "@/lib/imeta";

/**
 * Character cards (the "tavern" format) ride inside PNG files as a `tEXt`
 * chunk whose keyword is `chara` (V1/V2) or `ccv3` (V3) and whose payload is
 * base64-encoded UTF-8 JSON. The JSON shape is the Character Card V2 spec:
 * https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
 *
 * V1 cards are the flat fields; V2/V3 nest them under `data` next to a
 * `spec` marker. This module normalizes all three to one view model.
 */

export type CharaCardSpec = "v1" | "v2" | "v3";

/** Normalized subset of a `character_book` entry (kept whole per the spec). */
export interface CharaCardBookEntry {
  keys: string[];
  content: string;
  name?: string;
  comment?: string;
  enabled: boolean;
  insertion_order?: number;
}

export interface CharaCardBook {
  name?: string;
  description?: string;
  entries: CharaCardBookEntry[];
}

/** A parsed character card, any spec revision. Only `name` is guaranteed. */
export interface CharaCard {
  spec: CharaCardSpec;
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings: string[];
  tags: string[];
  creator?: string;
  character_version?: string;
  character_book?: CharaCardBook;
}

/** Media reference subset the sniffer needs (an `ImageRef` satisfies it). */
export interface CharacterCardRef {
  url: string;
  encryption?: ImetaEncryption;
  mime?: string;
  fallbacks?: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** V1 fields: one of them must be a string, or a bare `{name}` object would pass as a card. */
const V1_REQUIRED_FIELDS = ["description", "personality", "scenario", "first_mes", "mes_example"];

function parseBook(value: unknown): CharaCardBook | undefined {
  const book = asRecord(value);
  if (!book || !Array.isArray(book.entries)) return undefined;
  const entries: CharaCardBookEntry[] = [];
  for (const raw of book.entries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const content = asString(entry.content);
    if (content === undefined) continue;
    entries.push({
      keys: asStringList(entry.keys),
      content,
      name: asString(entry.name) ?? asString(entry.comment),
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
      insertion_order: typeof entry.insertion_order === "number" ? entry.insertion_order : undefined,
    });
  }
  return { name: asString(book.name), description: asString(book.description), entries };
}

/**
 * Normalize a parsed JSON value to a card, or null. V2/V3 need their marker
 * and a `data` object; anything else is tried as a bare V1 card.
 */
export function parseCharacterCardJson(value: unknown): CharaCard | null {
  const root = asRecord(value);
  if (!root) return null;

  let spec: CharaCardSpec;
  let data: Record<string, unknown>;
  if ((root.spec === "chara_card_v3" || root.spec === "chara_card_v2") && asRecord(root.data)) {
    spec = root.spec === "chara_card_v3" ? "v3" : "v2";
    data = asRecord(root.data)!;
  } else {
    spec = "v1";
    data = root;
    if (!V1_REQUIRED_FIELDS.some((k) => typeof data[k] === "string")) return null;
  }

  const name = asString(data.name)?.trim();
  if (!name) return null;

  return {
    spec,
    name,
    description: asString(data.description),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    first_mes: asString(data.first_mes),
    mes_example: asString(data.mes_example),
    creator_notes: asString(data.creator_notes),
    system_prompt: asString(data.system_prompt),
    post_history_instructions: asString(data.post_history_instructions),
    alternate_greetings: asStringList(data.alternate_greetings),
    tags: asStringList(data.tags),
    creator: asString(data.creator),
    character_version: asString(data.character_version),
    character_book: parseBook(data.character_book),
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `tEXt` keywords carrying a card payload; `chara_ext-*` siblings are asset pointers, not cards. */
const CARD_TEXT_KEYWORDS = new Set(["chara", "ccv3"]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Base64 of UTF-8 (TextDecoder), tolerant of the whitespace some writers wrap in. */
function decodeCardPayload(b64: string): unknown {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Whether the bytes open with the PNG signature. */
export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

interface PngChunk {
  type: string;
  /** Whole chunk, length through CRC. */
  start: number;
  end: number;
  dataStart: number;
  dataEnd: number;
}

/** The chunk framing up to IEND or the first malformed chunk; `complete` = IEND reached. */
function pngChunks(bytes: Uint8Array): { chunks: PngChunk[]; complete: boolean } | null {
  if (bytes.length < 8 + 8 || !isPngBytes(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const dataStart = offset + 8;
    const end = dataStart + length + 4; // + CRC
    if (end > bytes.length) break;
    const type = ascii(bytes, offset + 4, 4);
    chunks.push({ type, start: offset, end, dataStart, dataEnd: dataStart + length });
    if (type === "IEND") return { chunks, complete: true };
    offset = end;
  }
  return { chunks, complete: false };
}

/** A `tEXt` chunk's NUL-terminated Latin-1 keyword, or undefined. */
function textKeyword(bytes: Uint8Array, chunk: PngChunk): string | undefined {
  if (chunk.type !== "tEXt") return undefined;
  for (let i = chunk.dataStart; i < chunk.dataEnd; i++) {
    if (bytes[i] === 0) return i > chunk.dataStart ? ascii(bytes, chunk.dataStart, i - chunk.dataStart) : undefined;
  }
  return undefined;
}

function cardFromChunk(bytes: Uint8Array, chunk: PngChunk, keyword: string): CharaCard | null {
  const payloadStart = chunk.dataStart + keyword.length + 1;
  try {
    return parseCharacterCardJson(decodeCardPayload(ascii(bytes, payloadStart, chunk.dataEnd - payloadStart)));
  } catch {
    return null;
  }
}

/**
 * Read a PNG's `tEXt` card payload. A V3 writer keeps a `chara` copy for older
 * readers beside its `ccv3`, which is the one that wins. Other chunks' validity
 * is not checked, and malformed framing ends the walk.
 */
export function characterCardFromPngBytes(bytes: Uint8Array): CharaCard | null {
  const walked = pngChunks(bytes);
  if (!walked) return null;
  let fallback: CharaCard | null = null;
  for (const chunk of walked.chunks) {
    const keyword = textKeyword(bytes, chunk);
    if (!keyword || !CARD_TEXT_KEYWORDS.has(keyword)) continue;
    const card = cardFromChunk(bytes, chunk, keyword);
    if (!card) continue;
    if (keyword === "ccv3") return card;
    fallback ??= card;
  }
  return fallback;
}

/** Metadata chunks a card upload drops: EXIF, XMP (`iTXt`), compressed text and timestamps. */
const STRIPPED_CHUNKS = new Set(["eXIf", "iTXt", "zTXt", "tIME"]);

/**
 * The card PNG with every other metadata chunk removed, byte-for-byte otherwise:
 * image data and the card's own `tEXt` chunks (`chara`, `ccv3`, `chara_ext-*`)
 * are copied verbatim, CRCs and all. Null unless the framing walks to IEND.
 */
export function stripNonCardMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const walked = pngChunks(bytes);
  if (!walked?.complete) return null;
  const kept = walked.chunks.filter((chunk) => {
    if (STRIPPED_CHUNKS.has(chunk.type)) return false;
    if (chunk.type !== "tEXt") return true;
    const keyword = textKeyword(bytes, chunk);
    return keyword !== undefined && (CARD_TEXT_KEYWORDS.has(keyword) || keyword.startsWith("chara_ext-"));
  });
  const out = new Uint8Array(8 + kept.reduce((n, c) => n + (c.end - c.start), 0));
  out.set(bytes.subarray(0, 8), 0);
  let at = 8;
  for (const chunk of kept) {
    out.set(bytes.subarray(chunk.start, chunk.end), at);
    at += chunk.end - chunk.start;
  }
  return out;
}

/** Sniff-worthy by filename or declared MIME; other types short-circuit before any fetch. */
export function isCharacterCardCandidate(url: string, mime?: string): boolean {
  if (mime && !mime.startsWith("application/octet-stream")) {
    return mime.toLowerCase() === "image/png";
  }
  return /\.png$/i.test(url.split(/[?#]/, 1)[0]);
}

/** A card PNG is image data, but sniffing never justifies a video's worth of bytes. */
const SNIFF_MAX_BYTES = 48 * 1024 * 1024;

/**
 * Sniff results by attachment, card or "not a card". A failed fetch is dropped
 * so the next mount retries. Holds decrypted card text: cleared on logout.
 */
const sniffCache = new Map<string, Promise<CharaCard | null>>();
const SNIFF_CACHE_MAX = 64;

/** Forget every sniffed card (purgeClientStorage). */
export function clearCharacterCardCache(): void {
  sniffCache.clear();
}

async function sniffPngBytes(ref: CharacterCardRef, sources: readonly string[]): Promise<Uint8Array> {
  if (ref.encryption?.algorithm) {
    // Device-uploaded files are still in memory; the chat pipeline's decrypt
    // cache covers the rest, so a card costs no extra network fetch.
    const primed = peekPrimedAttachment(ref.url, ref.encryption);
    const primary = sources[0] ?? ref.url;
    const objectUrl = primed ?? await decryptAttachmentToObjectURL(primary, ref.encryption, ref.mime ?? "image/png", {
      alternates: sources.slice(1),
    });
    const res = await fetch(objectUrl);
    return new Uint8Array(await res.arrayBuffer());
  }
  return new Uint8Array(await fetchCapped(sources, { maxBytes: SNIFF_MAX_BYTES }));
}

/**
 * Fetch a PNG (decrypting when the sender attached a key) and extract an
 * embedded character card. Resolves null for any non-card/failure, never
 * rejects. `sources` are the display candidates ({@link fetchCapped} order).
 */
export function sniffCharacterCard(
  ref: CharacterCardRef,
  sources: readonly string[],
): Promise<CharaCard | null> {
  const key = ref.encryption
    ? `${ref.url}\n${ref.encryption.key}\n${ref.encryption.nonce}`
    : ref.url;
  const hit = sniffCache.get(key);
  if (hit) return hit;
  if (sources.length === 0) return Promise.resolve(null);
  const promise: Promise<CharaCard | null> = sniffPngBytes(ref, sources).then(
    (bytes) => characterCardFromPngBytes(bytes),
    (): null => {
      if (sniffCache.get(key) === promise) sniffCache.delete(key);
      return null;
    },
  );
  if (sniffCache.size >= SNIFF_CACHE_MAX) {
    const oldest = sniffCache.keys().next().value;
    if (oldest !== undefined) sniffCache.delete(oldest);
  }
  sniffCache.set(key, promise);
  return promise;
}

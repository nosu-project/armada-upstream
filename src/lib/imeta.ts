import { bytesToHex } from "@noble/hashes/utils.js";

/** Parsed imeta entry from NIP-94 tags. */
export interface ImetaEntry {
  url: string;
  /** Thumbnail/poster URL; per NIP-17 encrypted with the file's key and nonce. */
  thumbnail?: string;
  mime?: string;
  /** Summary text (used as webxdc app name for webxdc attachments). */
  summary?: string;
  /** Realtime session id: `webxdc-topic` (Vector's field) or legacy `webxdc`. Opaque. */
  webxdc?: string;
  /** Pixel dimensions from NIP-94 `dim` tag, e.g. "1280x720". */
  dim?: string;
  blurhash?: string;
  /** Original filename from the `name` field (used to infer a MIME when `m` is absent). */
  name?: string;
  /** Declared byte size from the NIP-94 `size` field (sender-reported; display only). */
  size?: string;
  alt?: string;
  /** Click-to-reveal spoiler, carried as per-file `content-warning` (value is a reason, possibly empty). */
  spoiler?: boolean;
  /** Repeated `fallback` sources; encrypted with the same key and nonce as the file. */
  fallbacks?: string[];
  /**
   * Client-side AES-GCM blob encryption (Vector/0xChat). Present whenever
   * `encryption-algorithm` exists, even if unreadable — see {@link isSupportedEncryption}.
   */
  encryption?: ImetaEncryption;
}

export interface ImetaEncryption {
  /** Encryption algorithm, lowercased as sent (only `aes-gcm` is supported). */
  algorithm: string;
  /** AES-256 key as lowercase hex (64 chars), or the raw value if undecodable. */
  key: string;
  /** AES-GCM nonce/IV as lowercase hex (Vector uses a 16-byte, 0xChat-compatible nonce). */
  nonce: string;
  /** SHA-256 (hex) of the plaintext, verified after decrypting. Optional for forwards. */
  ox?: string;
}

/**
 * Whether we can decrypt this attachment. Separate from parsing so an unreadable
 * encrypted attachment isn't mistaken for plaintext (which would paint ciphertext).
 */
export function isSupportedEncryption(enc: ImetaEncryption | undefined): boolean {
  if (!enc) return false;
  return enc.algorithm === "aes-gcm" && isHex(enc.key, 64) && isHex(enc.nonce);
}

/**
 * Params for a companion blob (`thumb`/`image`, `fallback`): same key and
 * nonce per NIP-17, but `ox` is dropped since it hashes the main file.
 */
export function companionEncryption(enc: ImetaEncryption | undefined): ImetaEncryption | undefined {
  if (!enc) return undefined;
  return { algorithm: enc.algorithm, key: enc.key, nonce: enc.nonce };
}

/** Parse all imeta tags into a map keyed by URL. Works for any event kind. */
export function parseImetaMap(tags: string[][]): Map<string, ImetaEntry> {
  const map = new Map<string, ImetaEntry>();
  for (const tag of tags) {
    if (tag[0] !== 'imeta') continue;
    const entry: Record<string, string> = {};
    // `fallback` is the only repeatable field.
    const fallbacks: string[] = [];
    for (let i = 1; i < tag.length; i++) {
      const part = tag[i];
      const spaceIdx = part.indexOf(' ');
      if (spaceIdx === -1) {
        if (part === 'content-warning') entry[part] = '';
        continue;
      }
      const key = part.slice(0, spaceIdx);
      const value = part.slice(spaceIdx + 1);
      if (key === 'fallback') fallbacks.push(value);
      else entry[key] = value;
    }
    if (entry.url) {
      const enc = parseImetaEncryption(entry);
      map.set(entry.url, {
        url: entry.url,
        // NIP-94 defines both; `thumb` is the smaller preview, so prefer it.
        thumbnail: entry.thumb ?? entry.image,
        mime: entry.m,
        summary: entry.summary,
        // `webxdc-topic` is the interop field; `webxdc` keeps older sessions alive.
        webxdc: entry["webxdc-topic"] ?? entry.webxdc,
        dim: entry.dim,
        blurhash: entry.blurhash,
        name: entry.name,
        size: entry.size,
        alt: entry.alt || undefined,
        spoiler: "content-warning" in entry || undefined,
        fallbacks: fallbacks.length ? fallbacks : undefined,
        encryption: enc,
      });
    }
  }
  return map;
}

/**
 * Parse a NIP-17 kind-15 file message (`content` is the URL, metadata in
 * top-level tags — Amethyst/0xChat's shape). Undefined unless `url` is http(s).
 * A file without valid encryption still yields an entry.
 */
export function parseFileMessageTags(url: string, tags: string[][]): ImetaEntry | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  const flat: Record<string, string> = {};
  const fallbacks: string[] = [];
  for (const [name, value] of tags) {
    if (!name || value === undefined) continue;
    if (name === 'fallback') fallbacks.push(value);
    else if (!(name in flat)) flat[name] = value;
  }
  return {
    url,
    thumbnail: flat.thumb ?? flat.image,
    mime: flat["file-type"] ?? flat.m,
    dim: flat.dim,
    blurhash: flat.blurhash,
    name: flat.name,
    size: flat.size,
    webxdc: flat["webxdc-topic"] ?? flat.webxdc,
    fallbacks: fallbacks.length ? fallbacks : undefined,
    encryption: parseImetaEncryption(flat),
  };
}

function isHex(s: string | undefined, len?: number): s is string {
  if (!s) return false;
  if (len !== undefined && s.length !== len) return false;
  return s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s);
}

function base64ToBytes(value: string): Uint8Array | undefined {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Normalize `decryption-key`/`-nonce` to lowercase hex; senders use hex or
 * base64. Hex wins ambiguity (a misread base64 fails the key-length check).
 * Returns the value unchanged if neither decodes.
 */
function decodeKeyMaterial(value: string): string {
  const trimmed = value.trim();
  if (isHex(trimmed)) return trimmed.toLowerCase();
  const bytes = base64ToBytes(trimmed);
  return bytes && bytes.length > 0 ? bytesToHex(bytes) : value;
}

/**
 * Encryption params, or undefined when not encrypted. Returns a value for any
 * `encryption-algorithm`, even unsupported — validity is {@link isSupportedEncryption}'s job.
 */
function parseImetaEncryption(entry: Record<string, string>): ImetaEncryption | undefined {
  const algorithm = entry["encryption-algorithm"];
  if (!algorithm) return undefined;
  return {
    algorithm: algorithm.toLowerCase(),
    key: decodeKeyMaterial(entry["decryption-key"] ?? ""),
    nonce: decodeKeyMaterial(entry["decryption-nonce"] ?? ""),
    ox: isHex(entry.ox, 64) ? entry.ox.toLowerCase() : undefined,
  };
}

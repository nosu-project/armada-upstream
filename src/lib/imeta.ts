import { bytesToHex } from "@noble/hashes/utils.js";

/** Parsed imeta entry from NIP-94 tags. */
export interface ImetaEntry {
  url: string;
  /**
   * Thumbnail/poster URL. Per NIP-17 a `thumb` is encrypted with the same key
   * and nonce as the file it belongs to, so {@link encryption} decrypts both.
   */
  thumbnail?: string;
  mime?: string;
  /** Summary text (used as webxdc app name for webxdc attachments). */
  summary?: string;
  /**
   * The realtime session this Mini App belongs to. Read from `webxdc-topic`
   * (Vector's field, and what Armada now writes) or the legacy `webxdc` field,
   * which carried a UUID before the two clients converged. Opaque here: the
   * app stage and the coordination plane only ever compare it.
   */
  webxdc?: string;
  /** Pixel dimensions from NIP-94 `dim` tag, e.g. "1280x720". */
  dim?: string;
  /** Blurhash placeholder from NIP-94 `blurhash` tag. */
  blurhash?: string;
  /** Original filename from the `name` field (used to infer a MIME when `m` is absent). */
  name?: string;
  /** Declared byte size from the NIP-94 `size` field (sender-reported; display only). */
  size?: string;
  /** The sender's description of the media, from NIP-94 `alt`. */
  alt?: string;
  /**
   * Hidden behind a click-to-reveal cover, Discord's per-attachment spoiler.
   * Carried as `content-warning` — NIP-36's name, scoped to the one file
   * rather than the event — so its value is a (possibly empty) reason.
   */
  spoiler?: boolean;
  /**
   * Alternative sources for the same bytes, from repeated `fallback` fields.
   * Per NIP-17 a fallback is encrypted with the same key and nonce as the file,
   * so {@link encryption} decrypts every one of them.
   */
  fallbacks?: string[];
  /**
   * Client-side blob encryption metadata, as sent by Vector/0xChat for
   * Blossom attachments: the blob at `url` is AES-GCM ciphertext, decryptable
   * only with `key` + `nonce`. Present whenever the imeta carried an
   * `encryption-algorithm` AT ALL — including one we can't read, which is the
   * whole point: see {@link isSupportedEncryption}.
   */
  encryption?: ImetaEncryption;
}

/** AES-GCM blob-encryption parameters carried in an imeta tag. */
export interface ImetaEncryption {
  /** Encryption algorithm, lowercased as sent (only `aes-gcm` is supported). */
  algorithm: string;
  /** AES-256 key as lowercase hex (64 chars), or the raw value if undecodable. */
  key: string;
  /** AES-GCM nonce/IV as lowercase hex (Vector uses a 16-byte, 0xChat-compatible nonce). */
  nonce: string;
  /**
   * `ox` — SHA-256 (hex) of the PLAINTEXT, which the sender publishes alongside
   * the key. Verified after decrypting, so a swapped blob fails closed rather
   * than rendering. Optional: an uploader always knows it, a forward may not.
   */
  ox?: string;
}

/**
 * Whether we can actually decrypt this attachment.
 *
 * Kept separate from parsing on purpose. An attachment whose `encryption-algorithm`
 * we don't recognize — or whose key material is malformed — must NOT come back
 * as `undefined`, because callers read that as "not encrypted" and hand the URL
 * straight to an `<img src>`, painting ciphertext. They need to tell "plaintext"
 * apart from "encrypted, but unreadable by us" so the second case can fail
 * closed on a placeholder.
 */
export function isSupportedEncryption(enc: ImetaEncryption | undefined): boolean {
  if (!enc) return false;
  // A 32-byte AES-256 key and a non-empty nonce, both already normalized to hex.
  return enc.algorithm === "aes-gcm" && isHex(enc.key, 64) && isHex(enc.nonce);
}

/**
 * The same parameters, for a COMPANION blob — a `thumb`/`image` poster, or a
 * `fallback` source of a *different* file.
 *
 * NIP-17 encrypts a companion with the same key and nonce as the file it
 * belongs to, which is why one pair decrypts both. `ox` is the part that does
 * NOT carry over: it hashes the file's plaintext, and a poster is its own
 * blob, so verifying one against the other rejects a perfectly good thumbnail
 * every time.
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
    // `fallback` is the one repeatable field — every other one is single-valued,
    // so collapsing repeats (last wins) is right for them and lossy for it.
    const fallbacks: string[] = [];
    for (let i = 1; i < tag.length; i++) {
      const part = tag[i];
      const spaceIdx = part.indexOf(' ');
      if (spaceIdx === -1) {
        // The one field whose presence is the whole signal.
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
        // `webxdc-topic` is the interop field, so it wins; `webxdc` is what
        // Armada wrote before and still keeps older sessions alive.
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
 * Parse a NIP-17 kind-15 file message (`content` is the blob URL; the file
 * metadata rides in TOP-LEVEL tags, not an `imeta` tag) into an
 * {@link ImetaEntry}. This is the shape Amethyst/0xChat send for encrypted DM
 * attachments: `file-type` (MIME), `x`/`ox` (hashes), `size`, `dim`,
 * `blurhash`, `thumb`/`image`, and the `encryption-algorithm` /
 * `decryption-key` / `decryption-nonce` triple.
 *
 * For WebXDC Mini Apps, also extracts the `webxdc-topic` tag which identifies
 * the realtime gossip session (Vector's interop field).
 *
 * Returns `undefined` when `url` isn't a usable http(s) URL. Encryption is
 * attached only when the params parse as valid AES-GCM (see
 * {@link parseImetaEncryption}); a file message with no/invalid encryption
 * still yields an entry so a plaintext attachment renders.
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
    // NIP-17 file messages use `file-type` for the MIME; fall back to `m`.
    mime: flat["file-type"] ?? flat.m,
    dim: flat.dim,
    blurhash: flat.blurhash,
    name: flat.name,
    size: flat.size,
    // Extract webxdc-topic for Mini Apps (Vector's interop field)
    // Prefer webxdc-topic over legacy webxdc field
    webxdc: flat["webxdc-topic"] ?? flat.webxdc,
    fallbacks: fallbacks.length ? fallbacks : undefined,
    encryption: parseImetaEncryption(flat),
  };
}

/** Lowercase-hex validator (even length, hex digits only). */
function isHex(s: string | undefined, len?: number): s is string {
  if (!s) return false;
  if (len !== undefined && s.length !== len) return false;
  return s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s);
}

/** Decode a base64 (or base64url) string to bytes. */
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
 * Normalize a `decryption-key` / `decryption-nonce` to lowercase hex.
 *
 * Neither NIP-17 nor the NIP-94 encryption extension pins an encoding, and
 * senders in the wild use both hex and base64, so accept either. Hex wins the
 * ambiguity — every known sender uses it, and a base64 string that happens to
 * be all-hex-and-even-length decodes to the wrong LENGTH, which the 32-byte key
 * check in {@link isSupportedEncryption} then rejects rather than silently
 * mis-keying.
 *
 * Returns the value unchanged when it decodes as neither, so the caller can
 * still tell that the attachment claims to be encrypted.
 */
function decodeKeyMaterial(value: string): string {
  const trimmed = value.trim();
  if (isHex(trimmed)) return trimmed.toLowerCase();
  const bytes = base64ToBytes(trimmed);
  return bytes && bytes.length > 0 ? bytesToHex(bytes) : value;
}

/**
 * Build an {@link ImetaEncryption} from a raw imeta field map, or `undefined`
 * when the attachment is not encrypted.
 *
 * A value comes back whenever `encryption-algorithm` is present, EVEN IF the
 * algorithm is one we don't implement or the key material is malformed —
 * validity is {@link isSupportedEncryption}'s question, deliberately. Folding
 * "unreadable" back into `undefined` here is what would make a caller treat the
 * blob as plaintext and render ciphertext.
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

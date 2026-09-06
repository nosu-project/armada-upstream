import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import type { ImetaEncryption } from "@/lib/imeta";

/**
 * Decrypt client-encrypted Blossom attachments (Vector / 0xChat).
 *
 * Vector encrypts chat attachments with AES-256-GCM *before* uploading to
 * Blossom, so the blob at the URL is ciphertext (`ciphertext || 16-byte tag`,
 * which is exactly WebCrypto's `AES-GCM` output layout). The per-file key and
 * nonce ride in the message's NIP-92 `imeta` tag (`decryption-key` /
 * `decryption-nonce`), readable only by members who can open the event. Vector
 * uses a 16-byte (0xChat-compatible) nonce; WebCrypto's AES-GCM accepts an IV
 * of any length, so we pass the hex nonce through verbatim.
 *
 * Results are cached per (url, key, nonce) as object URLs. The same blob is
 * commonly rendered as an inline thumbnail and again in the lightbox, and
 * messages re-render frequently, so the object URL is shared across those.
 *
 * Each decrypted attachment holds its full plaintext bytes alive in a Blob for
 * as long as its object URL is live, so an unbounded, never-revoked cache is a
 * steady memory leak — on iOS Safari's low per-tab memory ceiling a media
 * channel scroll eventually OOM-kills the tab. The cache is therefore bounded
 * by total decrypted BYTES (not entry count: one 4K video dwarfs hundreds of
 * thumbnails), evicting least-recently-used entries and revoking their object
 * URLs. Revocation is deferred by a grace period so a `<video>`/`<img>` still
 * referencing a just-evicted URL keeps working until it can re-resolve.
 *
 * That cache budget bounds what is KEPT, which is a different question from
 * what a single decrypt may allocate: AES-GCM authenticates the whole message
 * and so cannot be streamed, meaning ciphertext and plaintext are necessarily
 * both resident before the budget is ever consulted. One hostile blob was
 * therefore enough to take the tab down regardless of the cache. Reads are now
 * capped (see {@link readCapped}) and decrypts run behind a small semaphore, so
 * a screenful of attachments can't all buffer at once either.
 */

/** Max total decrypted bytes to keep alive as object URLs (~192 MB). */
const MAX_CACHED_BYTES = 192 * 1024 * 1024;
/** How long to keep a revoked entry's object URL alive after eviction. */
const REVOKE_GRACE_MS = 30_000;

/**
 * How much ciphertext an automatic, inline decrypt will pull into memory
 * without being asked twice.
 *
 * Nothing about rendering a message is an instruction to allocate: an embed
 * decrypts because it scrolled into view, so the size is chosen by the sender.
 * 64 MB covers every image, voice message and ordinary chat video while
 * staying survivable in a WKWebView. Past it the UI offers an explicit
 * "decrypt anyway" rather than failing outright — see {@link FileTooLargeError}.
 */
export const MAX_DECRYPT_BYTES = 64 * 1024 * 1024;

/**
 * Ceiling for a decrypt the user explicitly asked for (the oversized-media
 * override, a download, a share). Still bounded — a `size` field is
 * sender-controlled and a click shouldn't authorize an unbounded fetch.
 */
export const MAX_EXPLICIT_DECRYPT_BYTES = 512 * 1024 * 1024;

/** Thrown when a body exceeds the caller's `maxBytes` budget. */
export class FileTooLargeError extends Error {
  /** Size in bytes: from Content-Length, or what had been read when we bailed. */
  readonly byteSize: number;

  constructor(byteSize: number) {
    super(`encrypted attachment is too large to decrypt: ${byteSize} bytes`);
    this.name = "FileTooLargeError";
    this.byteSize = byteSize;
  }
}

/**
 * Read a response body, refusing to buffer more than `maxBytes`.
 *
 * Content-Length is checked before a single byte is read, and the body is then
 * streamed through a running count so a server that under-reports the header
 * can't get past it either — the header alone is a promise from the same party
 * serving the bytes. With a usable Content-Length the buffer is preallocated,
 * which also keeps peak memory at one copy instead of the chunk list plus its
 * concatenation.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  const header = res.headers.get("content-length");
  const declared = header === null ? NaN : Number(header);
  const hasDeclared = Number.isFinite(declared) && declared >= 0;

  if (hasDeclared && declared > maxBytes) throw new FileTooLargeError(declared);

  if (!res.body) {
    // No streaming support (older WebViews) — Content-Length is all we have.
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new FileTooLargeError(buffer.byteLength);
    return buffer;
  }

  const reader = res.body.getReader();
  const limit = hasDeclared ? Math.min(declared, maxBytes) : maxBytes;
  const preallocated = hasDeclared ? new Uint8Array(declared) : undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      await reader.cancel();
      throw new FileTooLargeError(total + value.byteLength);
    }
    if (preallocated) preallocated.set(value, total);
    else chunks.push(value);
    total += value.byteLength;
  }

  if (preallocated) {
    // A short body is legal; hand back only what actually arrived.
    return total === preallocated.byteLength ? preallocated.buffer : preallocated.buffer.slice(0, total);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

/**
 * Limit how many decrypts run at once.
 *
 * Every visible attachment starts its own fetch + decrypt the moment it mounts,
 * so a media channel would otherwise hold a screenful of files in memory
 * simultaneously and contend for the main thread — each one within the cap and
 * the total far past it.
 */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

const withDecryptSlot = createSemaphore(3);

/**
 * Fetch a blob with a hard byte ceiling, for the callers that then decrypt it.
 *
 * Given several URLs — the order {@link mediaCandidates} produces — they are
 * the SAME bytes on different hosts, and are tried in turn: a network error or
 * a non-2xx moves to the next, so a dead or not-yet-mirrored server costs one
 * round-trip rather than the attachment. Two failures end the walk at once:
 * an abort, because the caller stopped wanting the bytes; and
 * {@link FileTooLargeError}, because a content-addressed blob is exactly as
 * big on every mirror. The last error is what surfaces when every host fails.
 */
export async function fetchCapped(
  urls: string | readonly string[],
  opts: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<ArrayBuffer> {
  const list = typeof urls === "string" ? [urls] : urls;
  if (list.length === 0) throw new Error("attachment fetch failed: no source");
  let lastError: unknown;
  for (const url of list) {
    try {
      const res = await fetch(url, { signal: opts.signal });
      if (!res.ok) throw new Error(`attachment fetch failed: HTTP ${res.status}`);
      return await readCapped(res, opts.maxBytes ?? MAX_DECRYPT_BYTES);
    } catch (e) {
      if (opts.signal?.aborted || e instanceof FileTooLargeError) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

interface Entry {
  /** Resolved object URL, or the in-flight fetch/decrypt promise. */
  promise: Promise<string>;
  /** Decrypted byte size (0 until resolved / on failure). */
  bytes: number;
  /** Resolved object URL once known, for revocation on eviction. */
  url?: string;
}

/** key = `${url}\n${key}\n${nonce}` → cache entry. Insertion order = LRU order. */
const cache = new Map<string, Entry>();
let totalBytes = 0;

function cacheKey(url: string, enc: ImetaEncryption): string {
  return `${url}\n${enc.key}\n${enc.nonce}`;
}

/** Mark an entry most-recently-used (re-insert at the tail of the Map). */
function touch(k: string, entry: Entry): void {
  cache.delete(k);
  cache.set(k, entry);
}

/** Evict least-recently-used entries until the byte budget is satisfied. */
function evictToBudget(keep: string): void {
  for (const [k, entry] of cache) {
    if (totalBytes <= MAX_CACHED_BYTES) break;
    if (k === keep) continue; // never evict the entry we just resolved
    cache.delete(k);
    totalBytes -= entry.bytes;
    // Defer revocation: a still-mounted <img>/<video> may reference this URL
    // for another frame; give it a grace window to re-resolve first.
    const url = entry.url;
    if (url) setTimeout(() => URL.revokeObjectURL(url), REVOKE_GRACE_MS);
  }
}

/** Copy bytes into a fresh ArrayBuffer-backed view (WebCrypto wants `ArrayBuffer`, not `ArrayBufferLike`). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(ab);
  view.set(bytes);
  return view;
}

/**
 * Verify decrypted bytes against the sender's `ox` (plaintext SHA-256).
 *
 * The key travels in the event, so anyone who can read the message can also
 * decrypt — but the BLOB lives on a media server that no one authenticated.
 * Checking `ox` is what makes a swapped or truncated blob fail closed instead
 * of rendering. Skipped when the sender published no `ox`; a forward may not
 * carry one, and refusing those would break plenty of legitimate messages.
 */
export function verifyPlaintextHash(plaintext: Uint8Array, ox: string | undefined): void {
  if (!ox) return;
  if (bytesToHex(sha256(plaintext)) !== ox.toLowerCase()) {
    throw new Error("decrypted attachment does not match its `ox` hash");
  }
}

/**
 * The already-resolved object URL for an attachment, or `undefined` if it has
 * never been decrypted, is still in flight, or has since been evicted.
 *
 * Exists so a remount can paint on its FIRST frame. {@link decryptAttachmentToObjectURL}
 * returns a cached promise on a hit, but a promise — even an already-resolved
 * one — can only deliver its value in a microtask, so a component driven by it
 * alone renders a placeholder, commits, and only then mounts the `<img>`. That
 * is a wasted commit and a height change per attachment on every channel
 * switch, for bytes that were in memory the whole time.
 *
 * Counts as a use for LRU purposes: a blob that is being rendered is live
 * whether or not the caller went through the async path to get it.
 */
export function peekAttachmentObjectURL(url: string, enc: ImetaEncryption): string | undefined {
  const k = cacheKey(url, enc);
  const entry = cache.get(k);
  if (!entry?.url) return undefined;
  touch(k, entry);
  return entry.url;
}

/**
 * Fetch + AES-GCM-decrypt an encrypted attachment into an object URL suitable
 * for an `<img src>` / `<video src>`. `mime` is used as the resulting Blob's
 * type (display only).
 *
 * Throws on fetch / decrypt / integrity failure, and a {@link FileTooLargeError}
 * when the blob is past `maxBytes` — which callers should surface as its own
 * state, since unlike the others it's retryable with a bigger budget.
 *
 * `alternates` are other hosts holding the same ciphertext (declared
 * `fallback`s and derived Blossom mirrors), walked INSIDE this one resolve by
 * {@link fetchCapped}. The cache is keyed on the primary URL alone: whichever
 * host answered, it is the same blob under the same key and nonce.
 */
export async function decryptAttachmentToObjectURL(
  url: string,
  enc: ImetaEncryption,
  mime: string | undefined,
  opts: { signal?: AbortSignal; maxBytes?: number; alternates?: readonly string[] } = {},
): Promise<string> {
  const k = cacheKey(url, enc);
  const existing = cache.get(k);
  if (existing) {
    touch(k, existing);
    return existing.promise;
  }

  const entry: Entry = { promise: Promise.resolve(""), bytes: 0 };

  entry.promise = withDecryptSlot(async () => {
    const ciphertext = await fetchCapped([url, ...(opts.alternates ?? [])], opts);
    // Hand the ArrayBuffer straight through: `readCapped` and `crypto.subtle`
    // both already return one and a Blob accepts one, so threading buffers
    // rather than views saves two full copies of a video.
    const plaintext = await decryptBuffer(ciphertext, enc.key, enc.nonce);
    verifyPlaintextHash(new Uint8Array(plaintext), enc.ox);
    const blob = new Blob([plaintext], { type: mime || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    // Record the resolved size + URL, then trim the cache to the byte budget.
    if (cache.get(k) === entry) {
      entry.bytes = plaintext.byteLength;
      entry.url = objectUrl;
      totalBytes += entry.bytes;
      evictToBudget(k);
    }
    return objectUrl;
  });

  // Cache the in-flight entry so concurrent renders share one fetch/decrypt;
  // drop it on failure so a transient error can be retried.
  cache.set(k, entry);
  entry.promise.catch(() => {
    if (cache.get(k) === entry) {
      cache.delete(k);
      totalBytes -= entry.bytes;
    }
  });

  return entry.promise;
}

/** Result of encrypting a file for upload: the ciphertext blob + the params to put in imeta. */
export interface EncryptedUpload {
  /** Ciphertext as a File (`ciphertext || 16-byte GCM tag`), ready to upload to Blossom. */
  file: File;
  /** AES-256 key as lowercase hex (64 chars). */
  key: string;
  /** 16-byte GCM nonce as lowercase hex (0xChat / Vector compatible). */
  nonce: string;
  /** SHA-256 (hex) of the ORIGINAL plaintext — published as the imeta `ox` field. */
  originalHash: string;
}

/**
 * Encrypt a file with AES-256-GCM for a client-encrypted Blossom upload,
 * matching Vector / 0xChat: a random 32-byte key and a **16-byte** nonce, with
 * the WebCrypto output (`ciphertext || 16-byte tag`) uploaded verbatim. The
 * returned key/nonce go into the message's `imeta` (`decryption-key` /
 * `decryption-nonce`) so members can decrypt; the blob on Blossom stays
 * ciphertext-at-rest.
 *
 * The ciphertext File keeps the original MIME type — many Blossom servers
 * reject `application/octet-stream`, and Vector sends the original MIME for
 * the same reason.
 */
export async function encryptFileForUpload(file: File): Promise<EncryptedUpload> {
  return encryptFileWithParams(
    file,
    bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    bytesToHex(crypto.getRandomValues(new Uint8Array(16))), // 16-byte (0xChat-compatible) nonce
  );
}

/**
 * Encrypt a file under caller-supplied AES-GCM parameters.
 *
 * Used for the companion blobs of an attachment — NIP-17 specifies that a
 * `thumb` (and any `fallback` source) is "encrypted with the same key, nonce"
 * as the file it belongs to, which is what lets every other client decrypt a
 * thumbnail from the single `decryption-key`/`decryption-nonce` pair in the
 * message.
 */
export async function encryptFileWithParams(
  file: File,
  key: string,
  nonce: string,
): Promise<EncryptedUpload> {
  const plaintext = new Uint8Array(await file.arrayBuffer());

  const ciphertext = await encryptBytes(plaintext, key, nonce);

  const encryptedFile = new File([ciphertext], file.name, {
    type: file.type || "application/octet-stream",
  });

  return {
    file: encryptedFile,
    key,
    nonce,
    originalHash: bytesToHex(sha256(plaintext)),
  };
}

/**
 * AES-256-GCM encrypt raw bytes with a hex key + nonce. Output is WebCrypto's
 * `ciphertext || 16-byte tag` layout (identical to Vector's 16-byte-nonce
 * aes-gcm), so blobs are decryptable cross-client. Exported for testing.
 */
export async function encryptBytes(
  plaintext: Uint8Array,
  keyHex: string,
  nonceHex: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", buf(hexToBytes(keyHex)), "AES-GCM", false, ["encrypt"]);
  const ctBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(hexToBytes(nonceHex)) },
    cryptoKey,
    buf(plaintext),
  );
  return new Uint8Array(ctBuffer);
}

/**
 * AES-256-GCM decrypt with a hex key + nonce, taking and returning an
 * `ArrayBuffer`.
 *
 * The buffer-in/buffer-out shape is the one that avoids copying a whole video
 * twice: `readCapped` and `crypto.subtle.decrypt` both already produce an
 * ArrayBuffer, and a `Blob` accepts one, so the media path never has to
 * materialize a view just to hand it on.
 */
export async function decryptBuffer(
  ciphertext: BufferSource,
  keyHex: string,
  nonceHex: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", buf(hexToBytes(keyHex)), "AES-GCM", false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(hexToBytes(nonceHex)) }, cryptoKey, ciphertext);
}

/** {@link decryptBuffer} for the callers that want bytes. Exported for testing. */
export async function decryptBytes(
  ciphertext: Uint8Array,
  keyHex: string,
  nonceHex: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await decryptBuffer(buf(ciphertext), keyHex, nonceHex));
}


import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { readCachedImage, writeCachedImage } from "@/concord-v1/lib/imageBlobCache";

import type { CommunityImage } from "@/concord-v1/lib/types";

/**
 * Encrypted community images (logo / banner) — ported from Vector's
 * `CommunityImage` model. The blob is AES-256-GCM encrypted client-side before
 * upload, so a Blossom host / relay scraper without membership sees only
 * ciphertext; the per-image key + nonce ride inside the ServerRoot-sealed
 * GroupRoot metadata, available only to members.
 *
 * `hash` is the SHA-256 of the PLAINTEXT, checked after decrypt for integrity.
 */

/** AES-GCM encrypt file bytes; returns the ciphertext bytes + the key/nonce/hash to seal in metadata. */
export async function encryptImage(
  file: File | Blob,
  ext: string,
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; key: string; nonce: string; hash: string; ext: string }> {
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  // 16-byte (128-bit) nonce — matches Vector's `generate_encryption_params`
  // (`AesGcm::<Aes256, U16>`). Vector's `Nonce::<U16>` requires EXACTLY 16
  // bytes, so a 12-byte nonce here would make Armada-authored icons/banners
  // undecryptable on Vector. WebCrypto accepts any IV length, so reading
  // either client's blobs already works regardless.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));

  const cryptoKey = await crypto.subtle.importKey("raw", buf(keyBytes), "AES-GCM", false, ["encrypt"]);
  const ctBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonceBytes) }, cryptoKey, buf(plaintext));

  return {
    ciphertext: new Uint8Array(ctBuffer),
    key: bytesToHex(keyBytes),
    nonce: bytesToHex(nonceBytes),
    hash: bytesToHex(sha256(plaintext)),
    ext,
  };
}

/**
 * Fetch + decrypt a {@link CommunityImage} to an object URL for display.
 * Verifies the plaintext SHA-256 against `image.hash`. The caller is
 * responsible for `URL.revokeObjectURL` when the image unmounts.
 *
 * Cross-reload cache: the decrypted plaintext is content-addressed by
 * `image.hash` in Cache Storage, so a reload serves the icon/banner from disk
 * instead of re-fetching the Blossom ciphertext and re-running AES-GCM.
 */
export async function decryptImageToObjectURL(
  image: CommunityImage,
  signal?: AbortSignal,
): Promise<string> {
  const mime = mimeForExt(image.ext);

  // Disk cache hit (content-addressed by the plaintext hash) — skip the
  // network fetch + decrypt entirely.
  const cached = await readCachedImage(image.hash, mime);
  if (cached) return URL.createObjectURL(cached);

  const res = await fetch(image.url, { signal });
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const ciphertext = new Uint8Array(await res.arrayBuffer());

  const cryptoKey = await crypto.subtle.importKey("raw", buf(hexToBytes(image.key)), "AES-GCM", false, ["decrypt"]);
  const ptBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(hexToBytes(image.nonce)) },
    cryptoKey,
    buf(ciphertext),
  );
  const plaintext = new Uint8Array(ptBuffer);

  if (bytesToHex(sha256(plaintext)) !== image.hash) {
    throw new Error("image integrity check failed");
  }
  // Persist the verified plaintext for future reloads (best-effort).
  if (image.hash) void writeCachedImage(image.hash, plaintext, mime);
  return URL.createObjectURL(new Blob([plaintext], { type: mime }));
}

/** Best-effort mime for an extension (display only). */
function mimeForExt(ext: string): string {
  switch (ext.replace(/^\./, "").toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Extract a lowercase extension (no dot) from a filename, defaulting to "png". */
export function extOf(filename: string, fallback = "png"): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i + 1).toLowerCase() : fallback;
}

/**
 * Copy bytes into a fresh ArrayBuffer-backed Uint8Array. WebCrypto's lib.dom
 * types require `BufferSource` over a plain `ArrayBuffer` (not `ArrayBufferLike`,
 * which `@noble`'s `hexToBytes` returns); this normalizes the backing buffer.
 */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(ab);
  view.set(bytes);
  return view;
}

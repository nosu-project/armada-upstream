/**
 * Detection of embedded image metadata (EXIF, XMP, IPTC, comments).
 *
 * Used to decide whether an image must be re-encoded before upload. Phone
 * cameras embed GPS coordinates in EXIF, so an image that carries metadata is
 * re-encoded through a canvas — which drops every ancillary chunk — while a
 * clean image is uploaded byte-for-byte, avoiding needless generation loss.
 */

/** How much of the file to inspect. Metadata lives near the front in practice. */
export const METADATA_SCAN_BYTES = 64 * 1024;

/**
 * Whether `bytes` (the head of an image file) contains metadata worth
 * stripping.
 *
 * JPEG is parsed exactly by walking its marker segments. Other formats fall
 * back to scanning for known metadata chunk names, which can in principle
 * report a false positive — the cost of that is one unnecessary re-encode, so
 * the check errs toward stripping.
 */
export function hasStrippableMetadata(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;

  // JPEG: FF D8 followed by marker segments.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHasMetadata(bytes);

  return containsMetadataChunkName(bytes);
}

/**
 * Walk a JPEG's marker segments looking for the ones that carry metadata:
 * APP1 (EXIF/XMP), APP2 (ICC/FlashPix), APP13 (IPTC/Photoshop) and COM.
 *
 * Other APPn markers are left alone: APP0 is the JFIF header and APP14 is
 * Adobe's colour-transform marker, both of which affect decoding rather than
 * describing the photographer.
 */
function jpegHasMetadata(bytes: Uint8Array): boolean {
  let offset = 2;

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return false; // Desynced; stop guessing.

    const marker = bytes[offset + 1];

    // Start of scan: image data follows, no more metadata segments.
    if (marker === 0xda) return false;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    if (marker === 0xe1 || marker === 0xe2 || marker === 0xed || marker === 0xfe) return true;

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return false;
    offset += 2 + length;
  }

  return false;
}

/** Metadata container names used by PNG, WebP, HEIF and friends. */
const METADATA_CHUNK_NAMES = [
  "Exif\0\0", // EXIF payload signature
  "eXIf", // PNG EXIF chunk
  "tEXt",
  "iTXt",
  "zTXt",
  "XMP ", // WebP XMP chunk
  "EXIF", // WebP EXIF chunk
  "http://ns.adobe.com/xap", // XMP packet header
];

function containsMetadataChunkName(bytes: Uint8Array): boolean {
  // Decode as latin1 so byte values map 1:1 to code units.
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return METADATA_CHUNK_NAMES.some((name) => text.includes(name));
}

/**
 * Whether an image is animated, and so must not be round-tripped through a
 * canvas (which would flatten it to a single frame).
 */
export function isAnimatedImage(mime: string, bytes: Uint8Array): boolean {
  // Any multi-frame GIF; treating all GIFs as animated is the safe default and
  // GIF has no EXIF to leak anyway.
  if (mime === "image/gif") return true;

  if (mime === "image/webp") {
    // RIFF....WEBPVP8X with the animation flag, signalled by an ANIM chunk.
    for (let i = 12; i + 4 <= Math.min(bytes.length, 1024); i++) {
      if (bytes[i] === 0x41 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x49 && bytes[i + 3] === 0x4d) {
        return true;
      }
    }
    return false;
  }

  if (mime === "image/png" || mime === "image/apng") {
    // APNG is a PNG with an `acTL` chunk before the first `IDAT`.
    for (let i = 8; i + 4 <= Math.min(bytes.length, 4096); i++) {
      if (bytes[i] === 0x61 && bytes[i + 1] === 0x63 && bytes[i + 2] === 0x54 && bytes[i + 3] === 0x4c) {
        return true;
      }
      if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && bytes[i + 2] === 0x41 && bytes[i + 3] === 0x54) {
        return false;
      }
    }
    return false;
  }

  return false;
}

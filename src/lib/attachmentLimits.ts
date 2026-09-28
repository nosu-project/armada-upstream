import { mimeFromExt } from "@/lib/mediaUrls";
import { MAX_INPUT_BYTES } from "@/lib/video/policy";

/**
 * Device ceiling for encrypted attachments (size policy is the Blossom server's,
 * via BUD-06 preflight). AES-GCM seals in one call holding plaintext and
 * ciphertext in memory, so beyond this a phone tab can die.
 */
export const MAX_ENCRYPTED_BYTES = 100 * 1024 * 1024;

/**
 * Largest file an encrypted conversation can accept, or undefined when unbounded.
 * Videos may exceed {@link MAX_ENCRYPTED_BYTES} since the transcode can shrink them.
 */
export function deviceInputLimit(mime: string, encrypted: boolean): number | undefined {
  if (!encrypted) return undefined;
  return mime.startsWith("video/") ? MAX_INPUT_BYTES : MAX_ENCRYPTED_BYTES;
}

/** A picked file's MIME, falling back to its extension (browsers report `""` for e.g. `.avi`). */
export function mimeOfPicked(name: string, type: string): string {
  return type || mimeFromExt(name.split(".").pop()?.toLowerCase() ?? "");
}

/** Re-attaching the same bytes keeps the user's alt text and spoiler. */
export function keepUserFields(existing: string[][] | undefined, next: string[][]): string[][] {
  if (!existing) return next;
  const kept = existing.filter(
    (t) => (t[0] === "alt" || t[0] === "content-warning") && !next.some((n) => n[0] === t[0]),
  );
  return kept.length > 0 ? [...next, ...kept] : next;
}

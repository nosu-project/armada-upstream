import { mimeFromExt } from "@/lib/mediaUrls";
import { MAX_INPUT_BYTES } from "@/lib/video/policy";

/**
 * Size rules for composer attachments, and what survives re-attaching one.
 *
 * How big an upload may be is the Blossom server's call, not ours: it answers
 * a BUD-06 preflight (`blossomPreflight.ts`) and refuses the PUT with its own
 * reason. The one ceiling kept here is a DEVICE limit, not a policy: an
 * encrypted attachment is sealed in one AES-GCM call, which holds the whole
 * plaintext and the whole ciphertext in memory at once, and every recipient
 * holds both again to decrypt it. Past this a phone tab can simply die.
 */
export const MAX_ENCRYPTED_BYTES = 100 * 1024 * 1024;

/**
 * The largest file an encrypted conversation can take into the pipeline, or
 * undefined when nothing on this device bounds it. A video may arrive bigger
 * than {@link MAX_ENCRYPTED_BYTES}, because the transcode can bring it under —
 * but not past what the transcoder itself will take on, since a bigger one
 * passes through untouched and could never be sealed.
 */
export function deviceInputLimit(mime: string, encrypted: boolean): number | undefined {
  if (!encrypted) return undefined;
  return mime.startsWith("video/") ? MAX_INPUT_BYTES : MAX_ENCRYPTED_BYTES;
}

/**
 * A picked file's MIME, from its reported type or else its extension —
 * browsers report `""` for some containers (`.avi` commonly), which would
 * otherwise put a video under the document limit.
 */
export function mimeOfPicked(name: string, type: string): string {
  return type || mimeFromExt(name.split(".").pop()?.toLowerCase() ?? "");
}

/**
 * The same bytes resolve to the same Blossom URL, so attaching a file that is
 * already in the tray lands on the existing card. Its description and spoiler
 * were set by the user, not by the upload, and survive it.
 */
export function keepUserFields(existing: string[][] | undefined, next: string[][]): string[][] {
  if (!existing) return next;
  const kept = existing.filter(
    (t) => (t[0] === "alt" || t[0] === "content-warning") && !next.some((n) => n[0] === t[0]),
  );
  return kept.length > 0 ? [...next, ...kept] : next;
}

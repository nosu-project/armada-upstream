/**
 * Webxdc MIME: write Vector's `application/vnd.webxdc+zip` (Vector derives the
 * `.xdc` extension from it), but read the legacy `application/x-webxdc` too —
 * old messages must keep launching.
 */

export const WEBXDC_MIME = "application/vnd.webxdc+zip";

/** Every MIME a webxdc has been published under. Readers accept all of them. */
export const WEBXDC_MIMES: readonly string[] = [WEBXDC_MIME, "application/x-webxdc"];

/** Whether a MIME names a webxdc Mini App, in any client's spelling. */
export function isWebxdcMime(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return WEBXDC_MIMES.includes(mime.trim().toLowerCase());
}

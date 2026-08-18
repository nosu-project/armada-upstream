/**
 * The MIME a webxdc Mini App travels under.
 *
 * Two are in the wild. Vector writes `application/vnd.webxdc+zip`; Armada wrote
 * `application/x-webxdc` until this module existed. The difference is not
 * cosmetic across clients: Vector derives a downloaded file's extension from
 * the MIME whenever the `name` tag carries none, and its table only knows the
 * `vnd` form. The other falls through to a rule that slices the string after
 * the slash, so the app lands on disk as `<hash>.x-webxdc`, and Vector decides
 * a file is a Mini App by testing for exactly `xdc`. The game arrives as a
 * download that opens nothing.
 *
 * So: write one, read both, forever. Messages already on relays carry the old
 * MIME and must keep launching.
 */

/** What we write. Vector's, so a Mini App we send lands as `.xdc` on its disk. */
export const WEBXDC_MIME = "application/vnd.webxdc+zip";

/** Every MIME a webxdc has been published under. Readers accept all of them. */
export const WEBXDC_MIMES: readonly string[] = [WEBXDC_MIME, "application/x-webxdc"];

/** Whether a MIME names a webxdc Mini App, in any client's spelling. */
export function isWebxdcMime(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return WEBXDC_MIMES.includes(mime.trim().toLowerCase());
}

/**
 * Query options for react-queries that read LOCAL storage, whose `isPending`
 * drives skeletons. `retry: 0`: backoff retries would hold a skeleton ~7s and
 * a failed disk read won't recover on a timer. `networkMode: "always"`: don't
 * hide on-disk data while offline. Spread FIRST so callers can override.
 */
export const STORE_READ = {
  networkMode: "always",
  retry: 0,
} as const;

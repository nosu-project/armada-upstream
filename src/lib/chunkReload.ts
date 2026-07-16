/**
 * Stale-chunk recovery.
 *
 * Content-hashed build chunks (/assets/*.js) are immutable, so after a deploy a
 * tab that's been open across the deploy references hashes that may no longer
 * exist on the server. A dynamic `import()` of such a chunk then rejects (or,
 * with the SPA fallback returning 404, fails to load) — surfacing as a chunk
 * load error, or downstream as a React context/render crash.
 *
 * The recovery is a ONE-TIME hard reload: the fresh navigation fetches the
 * current index.html and its matching chunks, putting the tab on a consistent
 * build. A sessionStorage flag guards against reload loops when the failure is
 * NOT a stale chunk (e.g. genuinely offline), so we only auto-reload once per
 * session and otherwise fall through to the normal error UI.
 */

const RELOAD_FLAG = "armada:chunk-reloaded";

/**
 * Heuristic: does this error look like a stale/mismatched-build boot after a
 * deploy rather than an application logic bug? Matches two families:
 *  1. A dynamic import that 404s, times out, or returns the wrong MIME type
 *     (the chunk hash was pruned server-side) — plus a chunk resolving to an
 *     empty/HTML module.
 *  2. A render-phase crash from a MIX of old cached + new vendor chunks (e.g. an
 *     old vendor-radix wired to a fresh vendor-react). The duplicate/mismatched
 *     React copies surface as a hook called on a null dispatcher/context
 *     (`c.useContext(...) is null`, "Invalid hook call", …) — no chunk-y
 *     message, but still a stale-build symptom that a one-time reload fixes.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /'?text\/html'?.*not a valid JavaScript MIME type/i.test(message) ||
    /Loading (?:chunk|CSS chunk) .* failed/i.test(message) ||
    /ChunkLoadError/i.test(message) ||
    // A deploy that pruned old hashed chunks can leave a tab booting with a
    // MIX of old cached and new vendor chunks (e.g. an old vendor-radix against
    // a fresh vendor-react). The mismatched React instances then blow up in the
    // render phase rather than at import time — most often as a hook called on
    // a context that belongs to the "other" React copy. These have no chunk-y
    // message, so match the well-known React internal-hook null shapes too, so
    // the one-time reload recovers instead of stranding the user on the crash
    // screen. Reading a property (`.useContext`, `.useState`, …) of a null
    // dispatcher is the tell for a duplicate/mismatched React on boot.
    /\.use[A-Z]\w*\(?\.{0,3}\)? is null/i.test(message) ||
    /(?:null|undefined) is not an object.*\.use[A-Z]/i.test(message) ||
    /Cannot read propert(?:y|ies) of null \(reading 'use[A-Z]/i.test(message) ||
    /Cannot read property 'use[A-Z]\w*' of null/i.test(message) ||
    /Invalid hook call/i.test(message) ||
    /dispatcher is null/i.test(message)
  );
}

/**
 * If we haven't already tried this session, hard-reload to recover from a stale
 * chunk. Returns true if a reload was triggered (caller should stop / render a
 * neutral placeholder), false if we've already reloaded once (let the real
 * error surface so we don't loop).
 */
export function tryChunkReload(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    // sessionStorage unavailable (private mode / disabled): reload once,
    // unguarded, is still better than showing a broken screen.
  }
  window.location.reload();
  return true;
}

/**
 * Clear the guard once the app has booted successfully, so a later deploy in
 * the same session can recover again. Call after the app has mounted.
 */
export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    // ignore
  }
}

/**
 * Wrap a `React.lazy` import factory so a stale-chunk failure triggers the
 * one-time reload instead of bubbling a raw "Failed to fetch dynamically
 * imported module" into the Suspense error path.
 */
export function lazyWithReload<T>(factory: () => Promise<T>): () => Promise<T> {
  return () =>
    factory().catch((error) => {
      if (isChunkLoadError(error) && tryChunkReload()) {
        // Return a never-resolving promise: the page is reloading, so keep the
        // Suspense fallback up rather than flashing an error.
        return new Promise<T>(() => {});
      }
      throw error;
    });
}

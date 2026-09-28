/**
 * Stale-chunk recovery: after a deploy, an open tab may reference pruned
 * hashed chunks. Recover with a ONE-TIME hard reload per session
 * (sessionStorage-guarded against loops when the cause isn't a stale chunk).
 */

const RELOAD_FLAG = "armada:chunk-reloaded";

/**
 * Heuristic for a stale-build failure: a dynamic import that 404s/wrong MIME,
 * or a render crash from mixed old/new vendor chunks (duplicate React surfacing
 * as a hook on a null dispatcher).
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
    // Mixed old/new vendor chunks → duplicate React → hook calls on null dispatcher.
    /\.use[A-Z]\w*\(?\.{0,3}\)? is null/i.test(message) ||
    /(?:null|undefined) is not an object.*\.use[A-Z]/i.test(message) ||
    /Cannot read propert(?:y|ies) of null \(reading 'use[A-Z]/i.test(message) ||
    /Cannot read property 'use[A-Z]\w*' of null/i.test(message) ||
    /Invalid hook call/i.test(message) ||
    /dispatcher is null/i.test(message)
  );
}

/** Hard-reload once per session; false if already tried (let the error surface). */
export function tryChunkReload(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    // No sessionStorage: an unguarded reload beats a broken screen.
  }
  window.location.reload();
  return true;
}

/** Clear the guard after a successful mount so a later deploy can recover again. */
export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch { /* ignore */ }
}

/** Wrap a `React.lazy` factory so a stale-chunk failure triggers the one-time reload. */
export function lazyWithReload<T>(factory: () => Promise<T>): () => Promise<T> {
  return () =>
    factory().catch((error) => {
      if (isChunkLoadError(error) && tryChunkReload()) {
        // Never resolve: keep the Suspense fallback up while reloading.
        return new Promise<T>(() => {});
      }
      throw error;
    });
}

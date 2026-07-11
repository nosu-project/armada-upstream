/**
 * Build a namespaced localStorage key using the given app id.
 *
 * Keeps per-fork storage isolated and prevents two forks running on the same
 * origin (e.g. during local development) from clobbering each other's
 * preferences.
 *
 * @example
 *   const key = getStorageKey('armada', 'app-version');
 *   // → "armada:app-version"
 */
export function getStorageKey(appId: string, suffix: string): string {
  return `${appId}:${suffix}`;
}

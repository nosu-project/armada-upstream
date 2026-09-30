import type { ConfigName } from "@/build/buildConfig";

declare global {
  interface Window {
    /**
     * Browser environment variables, set by a same-origin script that runs
     * before the bundle (the CSP admits no inline one). Same names as the build.
     */
    ENV?: Record<string, unknown>;
  }
}

/**
 * A deployment setting: `window.ENV[name]` when the page defines it as a
 * string, even an empty one, else the value baked in at build time.
 *
 * Only a page has `window.ENV`. The service worker and the Electron main
 * process always get the build value — which keeps the desktop updater's
 * trusted release signers out of reach of anything the page is served with.
 */
export function config(name: ConfigName): string | undefined {
  const runtime = typeof window === "undefined" ? undefined : window.ENV;
  if (runtime && typeof runtime === "object") {
    const value = runtime[name];
    if (typeof value === "string") return value;
  }
  return __ARMADA_BUILD_CONFIG__[name];
}

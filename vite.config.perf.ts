import path from "node:path";

import { mergeConfig } from "vite";

import base from "./vite.config";

/**
 * The build `scripts/perf-profile.mjs` drives: the app plus the e2e seed
 * harnesses (`e2e/screenshotSeed.html`, `e2e/concordSeed.html`) as extra
 * entries, into `dist-perf/`.
 *
 * The seed page has to be served from the SAME origin as the app, because it
 * seeds the app's own IndexedDB — and profiling has to happen against a
 * production build, because a dev build's React is several times slower and
 * would put the wrong components at the top of every table. The normal build
 * deliberately never includes the harness, so it gets a config of its own.
 * Run with `VITE_PROFILE=1` for component names and render timings.
 */
export default mergeConfig(base, {
  build: {
    outDir: "dist-perf",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, "index.html"),
        seed: path.resolve(import.meta.dirname, "e2e/screenshotSeed.html"),
        concordSeed: path.resolve(import.meta.dirname, "e2e/concordSeed.html"),
      },
    },
  },
  preview: {
    port: 8282,
    strictPort: true,
  },
});

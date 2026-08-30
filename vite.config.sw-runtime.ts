/**
 * Bundles the service worker's runtime (`src/sw/pushRuntime.ts`) into
 * `dist/sw-crypto.js`.
 *
 * `public/sw.js` is a hand-written CLASSIC service worker (no bundler, no
 * `import`) on purpose — see its header. It can't unseal a gift wrap on its own
 * (NIP-44 needs secp256k1 ECDH + chacha, which WebCrypto doesn't provide), and
 * it can't reach the app's ArmadaDB, its presentation rules or its store
 * writers either. This emits a standalone IIFE it loads with `importScripts`.
 * Kept as its own build (like `electron/db.cjs`) so none of it enters the app
 * bundle and the worker stays a plain file the build-stamp plugin can rewrite.
 *
 * The EMITTED NAME is still `sw-crypto.js` even though the source is no longer
 * only crypto: it is the path an already-installed worker asks for, and a
 * worker only updates on the next navigation. Renaming it would 404 that
 * request on every existing install until the update landed, degrading push to
 * the generic wake-up for a cycle, in exchange for nothing.
 *
 * Runs AFTER the main `vite build` (which empties dist), writing one extra file
 * beside it — hence `emptyOutDir: false` and no public-dir copy. Not module
 * format: a classic worker's `importScripts` evaluates a script, not a module.
 */
import path from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    // A classic worker in iOS 16.4+ Safari; es2020 covers BigInt (secp256k1,
    // and Concord's epoch arithmetic) without asking for anything newer than
    // every push-capable engine has.
    target: "es2020",
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    lib: {
      entry: path.resolve(import.meta.dirname, "src/sw/pushRuntime.ts"),
      formats: ["iife"],
      // The bundle publishes itself onto the worker global as a side effect;
      // this name only receives the (empty) module exports.
      name: "ArmadaPushRuntimeBundle",
      fileName: () => "sw-crypto.js",
    },
  },
});

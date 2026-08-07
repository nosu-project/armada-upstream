/**
 * Bundles the service worker's NIP-17 unwrap helper into `dist/sw-crypto.js`.
 *
 * `public/sw.js` is a hand-written CLASSIC service worker (no bundler, no
 * `import`) on purpose — see its header. It can't unseal a gift wrap on its own
 * (NIP-44 needs secp256k1 ECDH + chacha, which WebCrypto doesn't provide), so
 * this emits a small standalone IIFE it loads with `importScripts`. Kept as its
 * own build (like `electron/db.cjs`) so the crypto never enters the app bundle
 * and the worker stays a plain file the build-stamp plugin can rewrite.
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
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // A classic worker in iOS 16.4+ Safari; es2020 covers BigInt (secp256k1)
    // without asking for anything newer than every push-capable engine has.
    target: "es2020",
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    lib: {
      entry: path.resolve(__dirname, "src/sw/dmCrypto.ts"),
      formats: ["iife"],
      // The bundle publishes itself onto the worker global as a side effect;
      // this name only receives the (empty) module exports.
      name: "ArmadaDmCryptoBundle",
      fileName: () => "sw-crypto.js",
    },
  },
});

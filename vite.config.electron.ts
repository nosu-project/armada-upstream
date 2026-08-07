/**
 * Bundles the Electron main process's ArmadaDB server into `electron/db.cjs`.
 *
 * The store is TypeScript under `src/lib/db/` and is shared with the renderer,
 * the tests and (in port) the Android service, so the main process gets a build
 * of that source rather than a hand-written JavaScript copy of it — a second
 * copy is a second engine, and the whole point of the arrangement is that there
 * is one.
 *
 * CommonJS because `electron/main.js` is CommonJS and `require`s it. `node:*`
 * stays external: the driver's `node:sqlite` is a builtin of the Node that
 * Electron embeds (43 → Node 24), not something to bundle.
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
    // Electron 43 embeds Node 24; nothing here needs downlevelling.
    target: "node22",
    outDir: "electron",
    // The web build's output is copied into electron/dist, and the shell's own
    // main.js/preload.js live here too.
    emptyOutDir: false,
    // This build emits ONE file into a source directory. public/ belongs to the
    // web build and already ships inside electron/dist; copied here as well it
    // would only spill untracked duplicates beside main.js that nothing loads.
    copyPublicDir: false,
    // Readable on purpose: this file ships inside the asar, and a stack trace
    // out of the main process is the only diagnostic a packaged app gives.
    minify: false,
    lib: {
      entry: path.resolve(__dirname, "src/lib/db/electronMain.ts"),
      formats: ["cjs"],
      fileName: () => "db.cjs",
    },
    rollupOptions: {
      external: [/^node:/],
    },
  },
});

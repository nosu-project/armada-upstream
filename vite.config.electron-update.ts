/**
 * Bundles the desktop shell's update feed into `electron/updateFeed.cjs`.
 *
 * `src/lib/desktopUpdate.ts` resolves the kind-30622 release event — the same
 * event `/downloads` renders — down to the one installer this machine can
 * self-update from. `electron/nostrUpdateProvider.js` requires this bundle and
 * wraps it in an electron-updater `Provider`; the split is what keeps the
 * event-parsing half testable by vitest with no Electron anywhere near it.
 *
 * Its own config rather than a second entry in `vite.config.electron.ts`: see
 * the note there about content-hashed shared chunks and `files:`.
 *
 * CommonJS because `electron/main.js` is CommonJS. `node:*` stays external —
 * builtins of the Node that Electron embeds, not something to bundle.
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
    copyPublicDir: false,
    // Readable on purpose: this file ships inside the asar, and a stack trace
    // out of the main process is the only diagnostic a packaged app gives.
    minify: false,
    lib: {
      entry: path.resolve(__dirname, "src/lib/desktopUpdate.ts"),
      formats: ["cjs"],
      fileName: () => "updateFeed.cjs",
    },
    rollupOptions: {
      external: [/^node:/],
    },
  },
});

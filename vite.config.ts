import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Stamps each build with a unique id:
 *  - index.html: fills the `<meta name="build">` placeholder so a device's
 *    running bundle can be identified from the DOM when debugging stale-PWA
 *    issues (installed iOS PWAs resume from memory and can serve a stale cached
 *    shell, making deploys appear to fail).
 *  - sw.js: rotates the SW cache name every build, so a new deploy changes the
 *    SW bytes (forcing a SW update) and drops the previous shell cache.
 */
function buildStamp(): Plugin {
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ") + "Z";
  return {
    name: "armada-build-stamp",
    transformIndexHtml(html) {
      return html.replaceAll("__BUILD_STAMP__", stamp);
    },
    closeBundle() {
      // sw.js is copied verbatim from public/ during the bundle write; stamp
      // it afterwards.
      const swPath = path.resolve(__dirname, "dist/sw.js");
      if (fs.existsSync(swPath)) {
        fs.writeFileSync(swPath, fs.readFileSync(swPath, "utf8").replaceAll("__BUILD_STAMP__", stamp));
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), buildStamp()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    onConsoleLog(log: string) {
      return !log.includes("React Router Future Flag Warning");
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/lucide-react")) {
            return "lucide-icons";
          }
          if (id.includes("node_modules")) {
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return "vendor-react";
            }
            if (id.includes("node_modules/@nostrify") || id.includes("node_modules/nostr-tools") || id.includes("node_modules/@noble") || id.includes("node_modules/@scure")) {
              return "vendor-nostr";
            }
            if (id.includes("node_modules/@radix-ui")) {
              return "vendor-radix";
            }
            if (id.includes("node_modules/@tanstack")) {
              return "vendor-tanstack";
            }
            if (id.includes("livekit")) {
              return "vendor-livekit";
            }
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
});

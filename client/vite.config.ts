import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()],
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

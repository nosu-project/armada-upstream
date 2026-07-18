import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Short commit SHA — prefer CI env var, fall back to git. Empty string if
 * unavailable (e.g. no git repo).
 */
function getCommitSha(): string {
  if (process.env.CI_COMMIT_SHORT_SHA) return process.env.CI_COMMIT_SHORT_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Git tag for the current commit — prefer CI env var, fall back to git. Empty
 * string if untagged (pre-release build).
 */
function getCommitTag(): string {
  if (process.env.CI_COMMIT_TAG) return process.env.CI_COMMIT_TAG;
  try {
    return execSync("git describe --exact-match --tags HEAD 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/**
 * The marketing version (X.Y.Z) for this build. Source of truth is the git tag
 * (per the release skill, package.json is never bumped). When on a tagged
 * commit, the tag minus its `v` prefix is used. For pre-release/dev builds, the
 * latest version from CHANGELOG.md is used so the footer matches the changelog
 * page (the caller appends a `+` suffix for untagged builds).
 */
function getVersion(): string {
  const tag = getCommitTag();
  if (tag) return tag.replace(/^v/, "");
  try {
    const changelog = fs.readFileSync(path.resolve(__dirname, "CHANGELOG.md"), "utf-8");
    const match = changelog.match(/^## \[([^\]]+)\]/m);
    if (match) return match[1];
  } catch {
    // fall through
  }
  return "0.0.0";
}

/**
 * Serves the repo-root CHANGELOG.md at /CHANGELOG.md in dev and copies it into
 * the build output, so the in-app changelog page and version-update toast can
 * fetch it without maintaining a duplicate copy in public/.
 */
function serveChangelog(): Plugin {
  const root = path.resolve(__dirname, "CHANGELOG.md");
  return {
    name: "armada-serve-changelog",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/CHANGELOG.md" && req.url !== "/CHANGELOG.md/") return next();
        try {
          const stat = fs.statSync(root);
          if (stat.isFile()) {
            res.setHeader("Content-Type", "text/markdown; charset=utf-8");
            res.end(fs.readFileSync(root, "utf-8"));
            return;
          }
        } catch {
          // fall through
        }
        next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve("dist");
      try {
        fs.copyFileSync(root, path.join(outDir, "CHANGELOG.md"));
      } catch {
        // no changelog — skip
      }
    },
  };
}

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
  plugins: [react(), buildStamp(), serveChangelog()],
  optimizeDeps: {
    // Pre-bundling would break the package's `new URL('sqlite3.wasm', …)`
    // asset resolution in dev; the worker imports it directly instead.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    // The sqlite worker is an ES module (it imports the wasm loader).
    format: "es",
  },
  define: {
    "import.meta.env.VERSION": JSON.stringify(getVersion()),
    "import.meta.env.BUILD_DATE": JSON.stringify(new Date().toISOString()),
    "import.meta.env.COMMIT_SHA": JSON.stringify(getCommitSha()),
    "import.meta.env.COMMIT_TAG": JSON.stringify(getCommitTag()),
  },
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

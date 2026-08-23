import { execSync } from "node:child_process";
import fs from "node:fs";
import { availableParallelism } from "node:os";
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
 *
 * Also stamps `__PUBLIC_ORIGIN__` into index.html's Open Graph tags. Those have
 * to be absolute (crawlers don't resolve relative ones), which means a
 * hardcoded host makes every build's link preview depend on THAT host being
 * reachable rather than the one it was deployed to — and an unfetchable
 * og:image degrades to the platform's generic placeholder, which is
 * indistinguishable from having no card at all.
 */
function buildStamp(): Plugin {
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ") + "Z";
  const origin = (process.env.VITE_PUBLIC_WEB_ORIGIN || "https://armada.buzz").replace(/\/$/, "");
  return {
    name: "armada-build-stamp",
    transformIndexHtml(html) {
      return html.replaceAll("__BUILD_STAMP__", stamp).replaceAll("__PUBLIC_ORIGIN__", origin);
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

/**
 * Worker ceiling for the suite. Vitest defaults to one worker per core and
 * then adds its own process on top, so the whole machine stalls for the length
 * of a run. Two cores held back is enough to keep it usable.
 *
 * Don't tighten this much further without cutting the work to match. Wall time
 * here is almost exactly `worker-seconds / workers` (measured within ~17% over
 * several runs), so the ceiling is paid back directly in duration — dropping
 * to 12 of 16 cores cancelled out the whole saving from the environment split
 * below. `ARMADA_TEST_WORKERS` overrides it for a box that wants all of itself
 * (CI) or less of it.
 */
const TEST_WORKERS = Number(process.env.ARMADA_TEST_WORKERS) ||
  Math.max(1, availableParallelism() - 2);

/**
 * Test options that are the same in both projects below. Only `name`,
 * `environment` and `include` differ.
 *
 * `maxWorkers` has to live HERE, on each project, not on the root `test`
 * config: with `projects` set, the root value is silently ignored, and the
 * suite goes back to a worker per core with nothing to say it didn't take.
 * Per-project is nonetheless a global ceiling and not one pool each — the
 * projects do not run concurrently (measured: 2 workers per project across
 * both is ~200% CPU, not ~400%).
 */
const SHARED_TEST_CONFIG = {
  globals: true,
  maxWorkers: TEST_WORKERS,
  setupFiles: "./src/test/setup.ts",
  onConsoleLog(log: string) {
    return !log.includes("React Router Future Flag Warning");
  },
} as const;

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), buildStamp(), serveChangelog()],
  worker: {
    // The video worker is an ES module (`new Worker(…, { type: "module" })`).
    format: "es",
  },
  define: {
    "import.meta.env.VERSION": JSON.stringify(getVersion()),
    "import.meta.env.BUILD_DATE": JSON.stringify(new Date().toISOString()),
    "import.meta.env.COMMIT_SHA": JSON.stringify(getCommitSha()),
    "import.meta.env.COMMIT_TAG": JSON.stringify(getCommitTag()),
  },
  test: {
    projects: [
      // Splitting by environment is the single biggest lever on suite cost. A
      // jsdom instance is built per test FILE, and at ~1.8s each that was
      // ~615s of the run's worker-time — more than actually running the tests
      // (~495s). The great majority of files never touch a DOM, so they get
      // `node` and skip that construction entirely (measured over a paired
      // run: ~615s -> ~222s of environment time, ~19% off the wall clock and
      // ~24% off the CPU consumed, using two fewer cores).
      //
      // The split is by EXTENSION rather than a list of paths, so there is no
      // roster in here to rot as files move: `.tsx` is a component/render test
      // and needs a DOM, `.ts` is assumed not to. The exceptions — a `.ts`
      // suite that drives `renderHook` or a browser shim — carry a
      // `// @vitest-environment jsdom` docblock, which overrides the project's
      // environment and travels with the file. A new one announces itself as
      // `document is not defined`, and the fix is that one line.
      {
        extends: true,
        test: {
          ...SHARED_TEST_CONFIG,
          name: "node",
          environment: "node",
          include: ["{src,electron}/**/*.test.{js,mjs,cjs,ts,mts,cts}"],
        },
      },
      {
        extends: true,
        test: {
          ...SHARED_TEST_CONFIG,
          name: "dom",
          environment: "jsdom",
          include: ["{src,electron}/**/*.test.{jsx,tsx}"],
        },
      },
    ],
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

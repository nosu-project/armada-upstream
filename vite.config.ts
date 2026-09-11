import { execSync } from "node:child_process";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";

import { manualChunks } from "./src/build/manualChunks";

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
    const changelog = fs.readFileSync(path.resolve(import.meta.dirname, "CHANGELOG.md"), "utf-8");
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
  const root = path.resolve(import.meta.dirname, "CHANGELOG.md");
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
      const swPath = path.resolve(import.meta.dirname, "dist/sw.js");
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

/**
 * `*.perf.test.*` files are BENCHMARKS: they assert on how long something takes
 * or how many times it re-renders, not on whether it is correct. They don't
 * belong in a correctness gate — a loaded machine makes them fail while nothing
 * is wrong, and they were ~13% of the suite's test time — so `npm run test`
 * skips them and `npm run test:perf` runs them alone.
 *
 * Two modes rather than a plain exclude, so the benchmarks stay reachable by
 * the same config that hides them. They are still typechecked and linted
 * either way; only the runner ignores them.
 */
const RUN_PERF = !!process.env.ARMADA_TEST_PERF;

/**
 * Build outputs a local flatpak build drops under `electron/`, which the
 * `electron/**` test globs must never traverse. `.flatpak-builder` holds
 * host-absolute symlinks (electron-builder.yml refuses to package it for the
 * same reason) and `release/` is a multi-GB OSTree repo; letting file discovery
 * descend either one hangs the whole run at startup rather than failing. Two
 * entries cover everything `flatpak/build.sh` writes: its build and repo
 * directories are both under `release/`. Applied in BOTH modes — the perf branch
 * had no exclude at all, so a stale build tree would hang `npm run test:perf`
 * too. CI never has these (each job is a fresh checkout); this only bites a
 * machine that has run `npm run dist:flatpak`.
 */
const BUILD_ARTIFACT_EXCLUDES = [
  "**/electron/.flatpak-builder/**",
  "**/electron/release/**",
];

/** `include`/`exclude` for one project, given the extensions it owns. */
function testFilesFor(extensions: string) {
  return RUN_PERF
    ? {
        include: [`{src,electron}/**/*.perf.test.${extensions}`],
        exclude: [...configDefaults.exclude, ...BUILD_ARTIFACT_EXCLUDES],
      }
    : {
        include: [`{src,electron}/**/*.test.${extensions}`],
        exclude: [...configDefaults.exclude, "**/*.perf.test.*", ...BUILD_ARTIFACT_EXCLUDES],
      };
}

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
    // The dev-server file watcher (chokidar) must never descend into a local
    // flatpak/OSTree build tree. It holds root-owned CIRCULAR symlinks (e.g.
    // `.flatpak-builder/cache/objects/**/udev/watch/*` -> `b251:0`) that crash
    // the watcher with `ELOOP` and take the whole dev server down mid-request —
    // which looks exactly like a hung dependency optimize. These are the same
    // host-absolute artifacts the vitest globs already dodge via
    // BUILD_ARTIFACT_EXCLUDES; the watcher needs its own guard because Vite
    // APPENDS `server.watch.ignored` to chokidar's defaults (`.git`,
    // `node_modules`) rather than replacing them. CI never has these (fresh
    // checkout); this only bites a machine that has run `npm run dist:flatpak`.
    watch: {
      ignored: BUILD_ARTIFACT_EXCLUDES,
    },
  },
  plugins: [react(), buildStamp(), serveChangelog()],
  optimizeDeps: {
    // Pin the dep-scanner's entry points to the real HTML entries. Left to its
    // default the scanner GLOBS `**/*.html` from the project root, and that
    // glob ignores only `outDir`/`__tests__`/`coverage` — NOT the local
    // flatpak/OSTree build tree. So on a machine that has run
    // `npm run dist:flatpak` it walks the 830 MB `.flatpak-builder` tree and
    // its root-owned circular symlinks, which reads as an optimize that never
    // finishes (distinct from the chokidar `ELOOP` crash the `server.watch`
    // guard above fixes — same tree, different traversal). Naming the entries
    // replaces the root glob with these literal paths. `e2e/harness.html` is
    // the Playwright harness (dev-server only, in no production build); listing
    // it keeps its deps pre-bundled so the e2e run doesn't pay a cold optimize.
    // `e2e/screenshotSeed.html` is the same, for the DM screenshot harness.
    entries: ["index.html", "e2e/harness.html", "e2e/screenshotSeed.html"],
  },
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
          ...testFilesFor("{js,mjs,cjs,ts,mts,cts}"),
          name: "node",
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          ...SHARED_TEST_CONFIG,
          ...testFilesFor("{jsx,tsx}"),
          name: "dom",
          environment: "jsdom",
        },
      },
    ],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
});

/**
 * Build the realtime transport (`crates/webxdc-rt`) into `src/wasm/`.
 *
 * Runs before `dev` and `build`, and is deliberately never fatal. The crate
 * needs a Rust toolchain, `wasm-pack`, and a real LLVM clang, none of which CI
 * or a frontend-only contributor has. Without it the app still runs and Mini
 * Apps still open and sync their state; only their multiplayer is off. A hard
 * failure here would make a Rust toolchain a requirement for working on the
 * chat UI.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "crates/webxdc-rt");
const out = join(root, "src/wasm/webxdc-rt");
const note = (m) => console.log(`[wasm] ${m}`);

const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

if (!has("cargo") || !has("wasm-pack")) {
  note("cargo or wasm-pack not found — skipping.");
  note("Mini App multiplayer will be off. To enable it:");
  note("  rustup target add wasm32-unknown-unknown && cargo install wasm-pack");
  process.exit(0);
}

// Skip when the output is newer than every source: `cargo` is fast on a no-op
// but wasm-pack still re-runs bindgen, which is a second on every dev start.
const newest = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((t, e) => {
    const p = join(dir, e.name);
    return Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }, 0);

// Both halves: an interrupted build can leave the wasm without its glue, and
// "up to date" would then mean multiplayer is off with no explanation.
const built = join(out, "webxdc_rt_bg.wasm");
const glue = join(out, "webxdc_rt.js");
const haveBuild = existsSync(built) && existsSync(glue);
if (haveBuild) {
  // Cargo.lock too: a dependency bump changes the output without touching src.
  const src = Math.max(
    newest(join(crate, "src")),
    statSync(join(crate, "Cargo.toml")).mtimeMs,
    existsSync(join(crate, "Cargo.lock")) ? statSync(join(crate, "Cargo.lock")).mtimeMs : 0,
  );
  if (statSync(built).mtimeMs > src) {
    note("up to date.");
    process.exit(0);
  }
}

note("building the realtime transport (first build takes a minute)...");
try {
  execFileSync("wasm-pack", ["build", "--release", "--target", "web", "--out-dir", out, crate], {
    stdio: "inherit",
    cwd: root,
  });
  note("built.");
} catch {
  // The previous output is still on disk and the app WILL load it, so saying
  // "off" would be a lie — and the dangerous kind, because a wire-format edit
  // would appear to have shipped when the running code predates it.
  note(
    haveBuild
      ? "build FAILED — the previous build is still in place and will be used. It may be stale."
      : "build failed — Mini App multiplayer will be off.",
  );
}
process.exit(0);

#!/bin/sh
set -eu

# Build the realtime transport (crates/webxdc-rt) into src/wasm/webxdc-rt
# WITHOUT wasm-pack, which is not packaged in any Flatpak SDK extension.
#
# This drives cargo + wasm-bindgen directly against the 25.08 rust-stable and
# llvm21 SDK extensions. wasm-pack does three things and only the middle one
# needs a tool that isn't in the SDK:
#
#   1. `cargo build` for wasm32-unknown-unknown.
#   2. `wasm-bindgen --target web` over the .wasm to emit the JS glue and the
#      trimmed _bg.wasm.
#   3. wasm-opt — which the crate ALREADY disables
#      (`[package.metadata.wasm-pack.profile.release] wasm-opt = false`, see
#      Cargo.toml), so there is nothing to replicate.
#
# Two things the SDK does NOT give us, and how each is handled:
#
#   * No prebuilt wasm32-unknown-unknown std, and no rustup to add one. The
#     rust-stable extension DOES bundle rust-src plus a vendored copy of std's
#     own registry deps, so std is built from source with `-Z build-std`. That
#     is a nightly flag; RUSTC_BOOTSTRAP=1 unlocks it on the stable compiler.
#     The std registry deps (libc &c.) are also merged into our own vendored
#     cargo sources (generated-sources.cargo.json) so `--offline` resolves them.
#   * No clang. iroh's `tls-ring` compiles C/asm for wasm32 through cc-rs, which
#     needs a wasm-capable clang; the llvm21 extension provides one. CC / AR are
#     pointed at it below (the bare `clang` cc-rs looks for is not on PATH).
#
# The output filenames must match what scripts/build-wasm.mjs and vite expect:
#   src/wasm/webxdc-rt/webxdc_rt_bg.wasm
#   src/wasm/webxdc-rt/webxdc_rt.js
# With those present and newer than the crate sources, the `prebuild` hook
# (scripts/build-wasm.mjs) finds no wasm-pack, sees a fresh build, and no-ops
# rather than reaching for the tool — so `npm run build` never needs it.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
crate="$root/crates/webxdc-rt"
out="$root/src/wasm/webxdc-rt"

target=wasm32-unknown-unknown

export PATH="/usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/llvm21/bin:$PATH"

# CARGO_HOME is set by the manifest to the module build root's `cargo/` dir,
# where generated-sources.cargo.json wrote `config` + `vendor/` (the vendored
# crate closure — application deps, the std registry deps `-Z build-std` pulls,
# AND wasm-bindgen-cli's own dependency closure). Every `cargo` invocation below
# therefore resolves entirely offline from that one vendor tree.

# 0. Build wasm-bindgen-cli 0.2.127 into a build-LOCAL prefix, offline, from the
#    vendored sources. It MUST match the crate's `wasm-bindgen` dependency
#    exactly (0.2.127); a skew between the .wasm's embedded schema and the CLI
#    is a hard error. It goes in a throwaway prefix rather than /app so the
#    5.7 MB host binary is not shipped in the final Flatpak — it is a build tool,
#    not a runtime artifact. Done first, with the SDK's normal (hardened) CFLAGS
#    still in effect, because this is a NATIVE build whose C deps (openssl-src)
#    expect them; the wasm-only CFLAGS surgery below would break it.
wbcli_prefix="$root/.flatpak-build-tools"
cargo install \
  --offline \
  --locked \
  --version 0.2.127 \
  --root "$wbcli_prefix" \
  wasm-bindgen-cli
export PATH="$wbcli_prefix/bin:$PATH"

# Build std from source on the stable toolchain. RUSTC_BOOTSTRAP=1 is what makes
# the otherwise-nightly `-Z build-std` available; rust-src ships in the
# extension, and the std registry deps are in our vendored cargo sources.
export RUSTC_BOOTSTRAP=1

# iroh's `ring` C for wasm32 goes through cc-rs, which shells out to a bare
# `clang`. Point it (and the archiver) at the llvm21 extension explicitly.
export CC_wasm32_unknown_unknown=/usr/lib/sdk/llvm21/bin/clang
export AR_wasm32_unknown_unknown=/usr/lib/sdk/llvm21/bin/llvm-ar

# The SDK build environment exports hardened CFLAGS (-fcf-protection,
# -fstack-clash-protection, _FORTIFY_SOURCE=3, …) that clang rejects when
# targeting wasm32 — the `ring` C compile dies on the first of them. Drop them
# for this cross-compile: an EMPTY CFLAGS_wasm32_unknown_unknown is treated by
# cc-rs as unset (it then falls back to the generic CFLAGS), so the generic ones
# are unset outright and the target var carries a single benign, wasm-accepted
# flag to take precedence. ring supplies its own -Oz and needs no hardening here.
unset CFLAGS CXXFLAGS CPPFLAGS 2>/dev/null || true
export CFLAGS_wasm32_unknown_unknown=-O2

# Cargo writes the target dir beside the manifest ($crate/target) under
# --manifest-path; pin it where the wasm is read from below instead.
export CARGO_TARGET_DIR="$root/target"

# 1. Compile the cdylib for wasm. --offline: every crate — application deps AND
#    the std deps build-std pulls — is vendored; a network fetch here is a build
#    failure, not a slow path.
cargo build \
  --release \
  --offline \
  -Z build-std=std,panic_abort \
  --target "$target" \
  --manifest-path "$crate/Cargo.toml"

wasm="$root/target/$target/release/webxdc_rt.wasm"
if [ ! -f "$wasm" ]; then
  echo "cargo did not produce $wasm" >&2
  exit 1
fi

# 2. Generate the web-target bindings with the `wasm-bindgen` built in step 0
#    (on PATH via the build-local prefix), at the SAME 0.2.127 the crate's
#    wasm-bindgen dependency pins — a version skew is a hard error. These flags
#    match `wasm-pack --target web`.
mkdir -p "$out"
wasm-bindgen \
  --target web \
  --out-dir "$out" \
  --out-name webxdc_rt \
  "$wasm"

# Sanity: the two files the loader needs must now exist.
test -f "$out/webxdc_rt_bg.wasm" || { echo "missing $out/webxdc_rt_bg.wasm" >&2; exit 1; }
test -f "$out/webxdc_rt.js"     || { echo "missing $out/webxdc_rt.js" >&2; exit 1; }

echo "Built webxdc-rt wasm into $out (no wasm-pack)"

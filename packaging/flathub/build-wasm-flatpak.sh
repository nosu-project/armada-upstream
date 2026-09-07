#!/bin/sh
set -eu

# Build the realtime transport (crates/webxdc-rt) into src/wasm/webxdc-rt
# without wasm-pack, which no Flatpak SDK extension ships. We drive cargo +
# wasm-bindgen directly; wasm-opt is already disabled by the crate. Output names
# (webxdc_rt_bg.wasm, webxdc_rt.js) match what scripts/build-wasm.mjs and vite
# expect, so the prebuild hook then sees a fresh build and no-ops.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
crate="$root/crates/webxdc-rt"
out="$root/src/wasm/webxdc-rt"

target=wasm32-unknown-unknown

export PATH="/usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/llvm21/bin:$PATH"

# CARGO_HOME (set by the manifest) holds the vendored crate closure: app deps,
# the std registry deps `-Z build-std` pulls, and wasm-bindgen-cli's own deps.
# Every cargo call below resolves offline from it.

# 0. Build wasm-bindgen-cli into a build-local prefix (not /app; it is a build
#    tool, not shipped). The version must match the crate's wasm-bindgen dep
#    exactly (0.2.127) or the schema/CLI skew is a hard error. Done first, while
#    the SDK's hardened CFLAGS still apply, since this native build's C deps
#    (openssl-src) expect them; the wasm-only CFLAGS below would break it.
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

# The SDK exports hardened CFLAGS (-fcf-protection, -fstack-clash-protection,
# _FORTIFY_SOURCE=3, and so on) that clang rejects for wasm32, so ring's C
# compile fails on the first. cc-rs treats an empty target CFLAGS var as unset
# and falls back to the generic ones, so we unset the generic vars outright and
# give the target var a single benign flag. ring supplies its own -Oz.
unset CFLAGS CXXFLAGS CPPFLAGS 2>/dev/null || true
export CFLAGS_wasm32_unknown_unknown=-O2

# Cargo writes the target dir beside the manifest ($crate/target) under
# --manifest-path; pin it where the wasm is read from below instead.
export CARGO_TARGET_DIR="$root/target"

# 1. Compile the cdylib for wasm, offline from the vendored crates.
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

# 2. Generate web-target bindings with the wasm-bindgen built in step 0. Flags
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

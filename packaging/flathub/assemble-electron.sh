#!/bin/sh
set -eu

# Assemble the Electron application directory into /app/armada, offline.
#
# electron-builder is unusable here: it downloads Electron and produces an
# AppImage, both disallowed in the sandbox. @electron/packager (an electron/
# devDependency) lays the app out around an Electron runtime taken from a local
# ZIP via `electronZipDir`, the one the flatpak-node offline cache already holds
# (flatpak-node/cache/electron/<url-hash>/electron-v<ver>-linux-<arch>.zip). The
# result is /app/armada/armada plus resources/app/, the path armada-wrapper
# execs through zypak.

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

# The Electron version must match electron/package.json's electron devDependency
# and the ZIP the generator cached. Read it from the installed package so the two
# cannot drift.
ver=$(node -p "require('$root/electron/node_modules/electron/package.json').version")

# Map the Flatpak arch to the Electron arch token in the cached ZIP name.
case "${FLATPAK_ARCH:-$(uname -m)}" in
  x86_64)  el_arch=x64 ;;
  aarch64) el_arch=arm64 ;;
  arm)     el_arch=armv7l ;;
  *) echo "unsupported arch: ${FLATPAK_ARCH:-$(uname -m)}" >&2; exit 1 ;;
esac

# All three release ZIPs share one url-dir hash; glob for this arch's.
zip=$(ls "$root"/flatpak-node/cache/electron/*/electron-v"${ver}"-linux-"${el_arch}".zip 2>/dev/null | head -n1 || true)
[ -n "$zip" ] && [ -f "$zip" ] || {
  echo "cached electron ZIP not found for linux-$el_arch v$ver" >&2
  exit 1
}
zipdir=$(dirname "$zip")

out="$root/electron-pkg"
rm -rf "$out"

# `prune: true` drops devDependencies from the copied tree without a package
# manager, so it stays offline; native (venmic/uiohook) and prod deps are kept.
# `ignore` drops build-only cruft with no place in the shipped app: the Go
# publisher's vendor tree, venmic's CPM checkouts, the self-hosted flatpak/
# scripts, and tests, mirroring electron-builder.yml's `files:` excludes. The
# runtime code the shell needs (db.cjs, updateFeed.cjs, dist/, icons, *.js) stays.
EL_DIR="$root/electron" EL_OUT="$out" EL_ARCH="$el_arch" EL_VER="$ver" EL_ZIPDIR="$zipdir" \
node -e '
const packager = require(process.env.EL_DIR + "/node_modules/@electron/packager");
packager({
  dir: process.env.EL_DIR,
  out: process.env.EL_OUT,
  platform: "linux",
  arch: process.env.EL_ARCH,
  electronVersion: process.env.EL_VER,
  electronZipDir: process.env.EL_ZIPDIR,
  executableName: "armada",
  overwrite: true,
  prune: true,
  ignore: [
    /\/hevc-publisher($|\/)/,
    /\/vendor-cpm($|\/)/,
    /\/flatpak($|\/)/,
    /\/generated($|\/)/,
    /\/release($|\/)/,
    /\/scripts($|\/)/,
    /\/electron-pkg($|\/)/,
    /\/\.flatpak-builder($|\/)/,
    /\.test\.mjs$/,
  ],
}).then((paths) => { console.log("packaged:", paths.join(", ")); })
  .catch((err) => { console.error(err); process.exit(1); });
'

app="$out/Armada-linux-$el_arch"
test -x "$app/armada" || { echo "packager did not produce $app/armada" >&2; exit 1; }

rm -rf /app/armada
mkdir -p /app
mv "$app" /app/armada
test -x /app/armada/armada

echo "Assembled Electron app into /app/armada (armada + resources/app)"

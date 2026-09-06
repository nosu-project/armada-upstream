#!/bin/sh
set -eu

# Assemble the Electron application directory into /app/armada, offline.
#
# electron-builder is unusable on Flathub: it downloads Electron and produces an
# AppImage, both disallowed in the network-isolated sandbox. @electron/packager
# (already an electron/ devDependency) does the one thing we need — lay the app
# out around an Electron runtime — and takes that runtime from a local ZIP via
# `electronZipDir` rather than the network. The ZIP is the one the flatpak-node
# offline cache already holds (generated-sources.npm.json,
# flatpak-node/cache/electron/<url-hash>/electron-v<ver>-linux-<arch>.zip).
#
# The result is /app/armada/armada (Electron renamed) plus resources/app/, which
# is exactly the path packaging/flathub/armada-wrapper execs through zypak.
# @electron/packager runs offline from the cached ZIP and emits that layout.

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

# `prune: true` drops devDependencies (electron, electron-builder,
# @electron/packager, …) from the copied tree without invoking a package
# manager, so it stays offline. venmic/uiohook (optional, native) and
# electron-updater/@jellybrick/dbus-next (prod) are kept.
# `ignore` drops build-only cruft that lives under electron/ but has no place in
# the shipped app — the Go publisher's 35 MB vendor tree, venmic's CPM git
# checkouts, the self-hosted flatpak/ scripts, tests. This mirrors what
# electron-builder.yml's `files:` excludes. (packager already ignores .git,
# node_modules/.bin and lockfiles.) The bundled runtime code the shell needs —
# db.cjs, updateFeed.cjs, dist/, build/ icons, the *.js modules — is kept.
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

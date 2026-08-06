#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
electron_dir=$(dirname -- "$script_dir")
release_dir="$electron_dir/release"
manifest="$script_dir/buzz.armada.app.yml"
staged_appimage="$release_dir/Armada.AppImage"
build_dir="$release_dir/flatpak-build"
repo_dir="$release_dir/flatpak-repo"
bundle="$release_dir/Armada-flatpak-$(uname -m).flatpak"

if ! command -v flatpak-builder >/dev/null 2>&1; then
  echo "flatpak-builder is required (install it from your Linux distribution)." >&2
  exit 1
fi

appimage=${1:-}
if [ -z "$appimage" ]; then
  for candidate in "$release_dir"/Armada-*-linux-*.AppImage; do
    if [ -f "$candidate" ]; then
      appimage=$candidate
    fi
  done
fi
if [ -z "$appimage" ] || [ ! -f "$appimage" ]; then
  echo "Usage: ./flatpak/build.sh path/to/Armada-*-linux-*.AppImage" >&2
  echo "Build one first with: npm run dist:linux" >&2
  exit 1
fi

mkdir -p "$release_dir"
if [ "$(realpath -- "$appimage")" != "$(realpath -m -- "$staged_appimage")" ]; then
  install -m755 "$appimage" "$staged_appimage"
fi

set -- --force-clean --disable-rofiles-fuse --default-branch=stable --repo="$repo_dir"
if [ -n "${FLATPAK_GPG_KEY:-}" ]; then
  set -- "$@" --gpg-sign="$FLATPAK_GPG_KEY"
fi
flatpak-builder "$@" "$build_dir" "$manifest"
flatpak build-bundle "$repo_dir" "$bundle" buzz.armada.app stable

echo "Flatpak bundle: $bundle"
echo "Update repository: $repo_dir"

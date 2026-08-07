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

builder=system
if command -v flatpak-builder >/dev/null 2>&1; then
  builder=system
elif command -v flatpak >/dev/null 2>&1 && flatpak info --user org.flatpak.Builder >/dev/null 2>&1; then
  builder=flatpak-user
elif command -v flatpak >/dev/null 2>&1 && flatpak info --system org.flatpak.Builder >/dev/null 2>&1; then
  builder=flatpak-system
else
  echo "flatpak-builder is required." >&2
  echo "Install the distro package, or: flatpak install --user flathub org.flatpak.Builder" >&2
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
case "$builder" in
  system)
    flatpak-builder "$@" "$build_dir" "$manifest"
    flatpak build-bundle "$repo_dir" "$bundle" buzz.armada.app stable
    ;;
  flatpak-user)
    flatpak run --user --command=sh \
      --env=ARMADA_FLATPAK_BUILD_DIR="$build_dir" \
      --env=ARMADA_FLATPAK_MANIFEST="$manifest" \
      --env=ARMADA_FLATPAK_REPO_DIR="$repo_dir" \
      --env=ARMADA_FLATPAK_BUNDLE="$bundle" \
      org.flatpak.Builder -c '
        set -eu
        export XDG_DATA_HOME="$HOME/.local/share"
        flatpak-builder "$@" "$ARMADA_FLATPAK_BUILD_DIR" "$ARMADA_FLATPAK_MANIFEST" &
        wait "$!"
        flatpak build-bundle "$ARMADA_FLATPAK_REPO_DIR" "$ARMADA_FLATPAK_BUNDLE" buzz.armada.app stable
      ' sh "$@"
    ;;
  flatpak-system)
    flatpak run --system --command=sh \
      --env=ARMADA_FLATPAK_BUILD_DIR="$build_dir" \
      --env=ARMADA_FLATPAK_MANIFEST="$manifest" \
      --env=ARMADA_FLATPAK_REPO_DIR="$repo_dir" \
      --env=ARMADA_FLATPAK_BUNDLE="$bundle" \
      org.flatpak.Builder -c '
        set -eu
        export XDG_DATA_HOME="$HOME/.local/share"
        flatpak-builder "$@" "$ARMADA_FLATPAK_BUILD_DIR" "$ARMADA_FLATPAK_MANIFEST" &
        wait "$!"
        flatpak build-bundle "$ARMADA_FLATPAK_REPO_DIR" "$ARMADA_FLATPAK_BUNDLE" buzz.armada.app stable
      ' sh "$@"
    ;;
esac

echo "Flatpak bundle: $bundle"
echo "Update repository: $repo_dir"

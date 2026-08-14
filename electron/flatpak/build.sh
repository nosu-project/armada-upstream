#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
electron_dir=$(dirname -- "$script_dir")
repo_root=$(dirname -- "$electron_dir")
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
# Always refresh the manifest's fixed source path. A previous optimization
# skipped this copy whenever the caller itself passed release/Armada.AppImage;
# local update cycles then silently repackaged the prior web bundle even after
# electron-builder had produced a new versioned AppImage beside it.
if [ "$(realpath -- "$appimage")" = "$(realpath -m -- "$staged_appimage")" ]; then
  echo "Refusing to build from the staging path itself: $staged_appimage" >&2
  echo "Pass the versioned electron-builder output (or no argument) so stale payloads cannot be repackaged." >&2
  exit 1
else
  install -m755 "$appimage" "$staged_appimage"
fi

# flatpak-builder keys local file sources by their manifest path, not by a
# release filename. Force the module rebuild when the staged AppImage changes;
# otherwise a fast local build can restore a cached /app/armada from a previous
# payload while still exporting a brand-new OSTree commit.
appimage_sha=$(sha256sum "$staged_appimage" | cut -d ' ' -f1)
printf '%s\n' "$appimage_sha" > "$release_dir/Armada.AppImage.sha256"

set -- --force-clean --disable-rofiles-fuse --default-branch=stable --repo="$repo_dir"
if [ -n "${FLATPAK_GPG_KEY:-}" ]; then
  set -- "$@" --gpg-sign="$FLATPAK_GPG_KEY"
fi
case "$builder" in
  system)
    flatpak-builder "$@" "$build_dir" "$manifest"
    if [ -n "${FLATPAK_GPG_KEY:-}" ]; then
      flatpak build-update-repo --gpg-sign="$FLATPAK_GPG_KEY" "$repo_dir"
    else
      flatpak build-update-repo "$repo_dir"
    fi
    flatpak build-bundle "$repo_dir" "$bundle" buzz.armada.app stable
    ;;
  flatpak-user)
    flatpak run --user --filesystem="$repo_root" --command=sh \
      --env=ARMADA_FLATPAK_BUILD_DIR="$build_dir" \
      --env=ARMADA_FLATPAK_MANIFEST="$manifest" \
      --env=ARMADA_FLATPAK_REPO_DIR="$repo_dir" \
      --env=ARMADA_FLATPAK_BUNDLE="$bundle" \
      --env=FLATPAK_GPG_KEY="${FLATPAK_GPG_KEY:-}" \
      org.flatpak.Builder -c '
        set -eu
        export XDG_DATA_HOME="$HOME/.local/share"
        flatpak-builder "$@" "$ARMADA_FLATPAK_BUILD_DIR" "$ARMADA_FLATPAK_MANIFEST" &
        wait "$!"
        if [ -n "$FLATPAK_GPG_KEY" ]; then
          flatpak build-update-repo --gpg-sign="$FLATPAK_GPG_KEY" "$ARMADA_FLATPAK_REPO_DIR"
        else
          flatpak build-update-repo "$ARMADA_FLATPAK_REPO_DIR"
        fi
        flatpak build-bundle "$ARMADA_FLATPAK_REPO_DIR" "$ARMADA_FLATPAK_BUNDLE" buzz.armada.app stable
      ' sh "$@"
    ;;
  flatpak-system)
    flatpak run --system --filesystem="$repo_root" --command=sh \
      --env=ARMADA_FLATPAK_BUILD_DIR="$build_dir" \
      --env=ARMADA_FLATPAK_MANIFEST="$manifest" \
      --env=ARMADA_FLATPAK_REPO_DIR="$repo_dir" \
      --env=ARMADA_FLATPAK_BUNDLE="$bundle" \
      --env=FLATPAK_GPG_KEY="${FLATPAK_GPG_KEY:-}" \
      org.flatpak.Builder -c '
        set -eu
        export XDG_DATA_HOME="$HOME/.local/share"
        flatpak-builder "$@" "$ARMADA_FLATPAK_BUILD_DIR" "$ARMADA_FLATPAK_MANIFEST" &
        wait "$!"
        if [ -n "$FLATPAK_GPG_KEY" ]; then
          flatpak build-update-repo --gpg-sign="$FLATPAK_GPG_KEY" "$ARMADA_FLATPAK_REPO_DIR"
        else
          flatpak build-update-repo "$ARMADA_FLATPAK_REPO_DIR"
        fi
        flatpak build-bundle "$ARMADA_FLATPAK_REPO_DIR" "$ARMADA_FLATPAK_BUNDLE" buzz.armada.app stable
      ' sh "$@"
    ;;
esac

echo "Flatpak bundle: $bundle"
echo "Update repository: $repo_dir"

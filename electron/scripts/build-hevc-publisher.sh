#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
electron_dir=$(dirname -- "$script_dir")
source_dir="$electron_dir/hevc-publisher"
patch_file="$electron_dir/flatpak/server-sdk-primary-codec.patch"

arch=x64
if [ "${1:-}" = "--arch" ]; then
  arch=${2:-}
elif [ -n "${1:-}" ]; then
  echo "Usage: $0 [--arch x64|arm64]" >&2
  exit 2
fi

case "$arch" in
  x64) goarch=amd64 ;;
  arm64) goarch=arm64 ;;
  *)
    echo "Unsupported Linux publisher architecture: $arch" >&2
    exit 2
    ;;
esac

for command in go git; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required to build the H.265 publisher." >&2
    exit 1
  fi
done

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/armada-hevc-publisher.XXXXXX")
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM

cp "$source_dir/go.mod" "$source_dir/go.sum" \
  "$source_dir/main.go" "$source_dir/main_test.go" "$work_dir/"

(
  cd "$work_dir"
  go mod vendor
  # The patch's context uses spaces so the patch file itself remains clean
  # under `git diff --check`; the pinned Go source uses tabs.
  git apply --ignore-space-change "$patch_file"
  go test -mod=vendor ./...

  output_dir="$electron_dir/generated/hevc/$arch"
  mkdir -p "$output_dir"
  temporary_output="$output_dir/.armada-hevc-publisher.$$"
  CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
    go build -mod=vendor -trimpath -buildvcs=false -ldflags='-s -w' \
      -o "$temporary_output" .
  chmod 755 "$temporary_output"
  mv -f "$temporary_output" "$output_dir/armada-hevc-publisher"
)

echo "Built generated/hevc/$arch/armada-hevc-publisher"

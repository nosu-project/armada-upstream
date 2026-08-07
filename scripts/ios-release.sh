#!/usr/bin/env bash
#
# Build the iOS app from a version tag. MUST run on a Mac with Xcode — there is
# no iOS CI and there cannot be one: ngit-ci executes workflows with `act`,
# which runs Linux containers only. (The macOS *desktop* build is cross-built
# from Linux because Electron ships prebuilt darwin binaries and `rcodesign`
# can ad-hoc sign them; an iOS app has no such escape hatch.)
#
# Version, like every other target, is carried by the git tag and never by a
# committed field (see .agents/skills/release/SKILL.md):
#
#   MARKETING_VERSION      = tag minus the leading "v"        (v0.31.1 -> 0.31.1)
#   CURRENT_PROJECT_VERSION = major*1_000_000 + minor*1_000 + patch  (-> 31001)
#
# The build-number scheme is deliberately identical to the Android versionCode
# in .ngit/act/workflows/release.yml: deterministic, monotonic with semver, and
# independent of checkout depth. Monotonicity is not cosmetic here — App Store
# Connect rejects an upload whose build number does not exceed the last one.
#
# Usage:
#   scripts/ios-release.sh                 # version from the tag at HEAD
#   scripts/ios-release.sh v0.31.1         # explicit tag
#   ARCHIVE=1 scripts/ios-release.sh       # archive for distribution instead of
#                                          # a simulator build

set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-$(git describe --tags --exact-match 2>/dev/null || true)}"
if [ -z "$TAG" ]; then
  echo "error: no version tag at HEAD; pass one explicitly (e.g. $0 v0.31.1)" >&2
  exit 1
fi
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "error: tag '$TAG' is not vX.Y.Z" >&2; exit 1 ;;
esac

VERSION_NAME="${TAG#v}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION_NAME"
VERSION_CODE="$(( MAJOR * 1000000 + MINOR * 1000 + PATCH ))"
echo "Building $VERSION_NAME (build $VERSION_CODE) from tag $TAG"

npm ci
npm run build
npx cap sync ios

cd ios/App

# NOTE: never add CODE_SIGNING_ALLOWED=NO, not even for the simulator. Unsigned
# means no keychain-access-group entitlement, so every
# capacitor-secure-storage-plugin write fails with errSecMissingEntitlement,
# surfacing as a bare "error" — and that is where the nsec lives.
COMMON=(
  -project App.xcodeproj
  -scheme App
  MARKETING_VERSION="$VERSION_NAME"
  CURRENT_PROJECT_VERSION="$VERSION_CODE"
)

if [ "${ARCHIVE:-}" = "1" ]; then
  xcodebuild "${COMMON[@]}" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "build/Armada-$VERSION_NAME.xcarchive" \
    archive
  echo "Archived to ios/App/build/Armada-$VERSION_NAME.xcarchive"
  echo "Export/upload from Xcode's Organizer, or with xcodebuild -exportArchive."
else
  xcodebuild "${COMMON[@]}" \
    -sdk iphonesimulator \
    -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    build
fi

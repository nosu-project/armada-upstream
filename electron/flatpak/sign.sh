#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
electron_dir=$(dirname -- "$script_dir")
release_dir=${ARMADA_FLATPAK_RELEASE_DIR:-$electron_dir/release}
if [ -n "${ARMADA_FLATPAK_RELEASE_DIR:-}" ]; then
  case "$ARMADA_FLATPAK_RELEASE_DIR" in
    /*) ;;
    *)
      echo "ARMADA_FLATPAK_RELEASE_DIR must be an absolute directory." >&2
      exit 1
      ;;
  esac
  if [ ! -d "$ARMADA_FLATPAK_RELEASE_DIR" ]; then
    echo "ARMADA_FLATPAK_RELEASE_DIR does not exist: $ARMADA_FLATPAK_RELEASE_DIR" >&2
    exit 1
  fi
  release_dir=$(realpath -- "$ARMADA_FLATPAK_RELEASE_DIR")
fi
repo_dir="$release_dir/flatpak-repo"
bundle="$release_dir/Armada-flatpak-$(uname -m).flatpak"
ARMADA_FLATPAK_REPO_URL=${ARMADA_FLATPAK_REPO_URL:-https://armada.buzz/downloads/flatpak/}

FLATPAK_GPG_KEY=${FLATPAK_GPG_KEY:-}
FLATPAK_GPG_PUBLIC_KEY=${FLATPAK_GPG_PUBLIC_KEY:-}

if [ -z "$FLATPAK_GPG_KEY" ] || [ -z "$FLATPAK_GPG_PUBLIC_KEY" ]; then
  echo "FLATPAK_GPG_KEY and FLATPAK_GPG_PUBLIC_KEY must both be set." >&2
  exit 1
fi
if [ ! -f "$FLATPAK_GPG_PUBLIC_KEY" ] || [ ! -r "$FLATPAK_GPG_PUBLIC_KEY" ]; then
  echo "FLATPAK_GPG_PUBLIC_KEY must name a readable public-key file: $FLATPAK_GPG_PUBLIC_KEY" >&2
  exit 1
fi
if [ ! -d "$repo_dir" ]; then
  echo "Flatpak repository not found: $repo_dir" >&2
  echo "Run ./flatpak/build.sh before ./flatpak/sign.sh." >&2
  exit 1
fi
for required_command in flatpak gpg ostree; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "$required_command is required to sign the release repository." >&2
    exit 1
  fi
done

# A published release must carry a summary INDEX (summary.idx and its immutable
# summaries/<sha256>.idx.sig shard), because modern clients read it instead of
# the legacy summary and CI refuses to deploy a repository without one. Flatpak
# only generates it from 1.13, so ask this flatpak whether it can rather than
# parsing a version string: on an older one the whole release tag would
# otherwise fail several minutes later, at a `test -s` that cannot say why.
if ! flatpak build-update-repo --help 2>&1 | grep -q -- '--no-summary-index'; then
  echo "This flatpak cannot generate a repository summary index." >&2
  echo "Flatpak 1.13 or newer is required to sign a release repository." >&2
  exit 1
fi

FLATPAK_GPG_PUBLIC_KEY=$(realpath -- "$FLATPAK_GPG_PUBLIC_KEY")

# Never embed a public key merely because it came from the expected secret.
# Match its one primary fingerprint to the full signing fingerprint so a
# malformed secret or stale public export cannot create unupdatable installs.
key_stage_dir=$(mktemp -d "$repo_dir/.flatpak-key.XXXXXX")
staged_public_key="$key_stage_dir/armada-flatpak.gpg"
staged_fingerprint="$key_stage_dir/armada-flatpak.fingerprint"
cleanup_key_stage() {
  rm -f -- "$staged_public_key" "$staged_fingerprint"
  rmdir -- "$key_stage_dir" 2>/dev/null || true
}
trap cleanup_key_stage 0 1 2 15
install -m644 "$FLATPAK_GPG_PUBLIC_KEY" "$staged_public_key"

if ! public_key_records=$(gpg --batch --show-keys --with-colons -- "$staged_public_key"); then
  echo "Unable to inspect FLATPAK_GPG_PUBLIC_KEY: $FLATPAK_GPG_PUBLIC_KEY" >&2
  exit 1
fi
public_key_fingerprints=$(
  printf '%s\n' "$public_key_records" | awk -F: '
    $1 == "pub" { awaiting_primary_fingerprint = 1; next }
    $1 == "sub" { awaiting_primary_fingerprint = 0; next }
    awaiting_primary_fingerprint && $1 == "fpr" {
      print $10
      awaiting_primary_fingerprint = 0
    }
  '
)
case "$public_key_fingerprints" in
  ''|*'
'*)
    echo "FLATPAK_GPG_PUBLIC_KEY must contain exactly one primary public key." >&2
    exit 1
    ;;
esac

normalized_signing_fingerprint=$(
  printf '%s' "$FLATPAK_GPG_KEY" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]'
)
normalized_public_fingerprint=$(
  printf '%s' "$public_key_fingerprints" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]'
)
case "$normalized_signing_fingerprint" in
  ''|*[!0-9A-F]*)
    echo "FLATPAK_GPG_KEY must be a full hexadecimal signing-key fingerprint." >&2
    exit 1
    ;;
esac
if [ "$normalized_signing_fingerprint" != "$normalized_public_fingerprint" ]; then
  echo "FLATPAK_GPG_KEY does not match the primary key in FLATPAK_GPG_PUBLIC_KEY." >&2
  exit 1
fi
FLATPAK_GPG_KEY=$normalized_signing_fingerprint

# Prepare the exact validated identity metadata that will be published beside
# the OSTree repository. Signing consumes this staged copy, and the canonical
# files do not appear until every Flatpak operation has succeeded.
published_public_key="$repo_dir/armada-flatpak.gpg"
published_fingerprint="$repo_dir/armada-flatpak.fingerprint"
printf '%s\n' "$FLATPAK_GPG_KEY" > "$staged_fingerprint"
chmod 644 "$staged_fingerprint"

set -- --gpg-sign="$FLATPAK_GPG_KEY"
if [ -n "${GNUPGHOME:-}" ]; then
  if [ ! -d "$GNUPGHOME" ] || [ ! -r "$GNUPGHOME" ] || [ ! -x "$GNUPGHOME" ]; then
    echo "GNUPGHOME must name a readable GnuPG home directory: $GNUPGHOME" >&2
    exit 1
  fi
  GNUPGHOME=$(realpath -- "$GNUPGHOME")
  set -- "$@" --gpg-homedir="$GNUPGHOME"
fi

# The build phase has finished before credentials enter this process. Add the
# app signature in-place, then sign every appstream commit generated by the
# unsigned build phase. The final metadata pass must not regenerate appstream,
# or those new commits would once again be unsigned.
flatpak build-sign "$@" "$repo_dir" buzz.armada.app stable

if ! repo_refs=$(ostree refs --repo="$repo_dir"); then
  echo "Unable to enumerate refs in the Flatpak repository." >&2
  exit 1
fi
appstream_refs=$(
  printf '%s\n' "$repo_refs" | awk -F/ '
    NF == 2 && ($1 == "appstream" || $1 == "appstream2") && $2 != "" { print }
  '
)
if [ -z "$appstream_refs" ]; then
  echo "Flatpak repository has no appstream/<arch> or appstream2/<arch> refs to sign." >&2
  exit 1
fi

# `ostree-metadata` backs the summary index on flatpak 1.14+, and the build
# phase generated it in its own credential-free `build-update-repo` pass. The
# later signed pass below runs `--no-update-appstream` and will not regenerate
# it, so without this it stays unsigned — while consumers verify EVERY ref the
# repository advertises, not just the app and its appstream. One unsigned
# metadata commit therefore fails the whole pull with
# "GPG verification enabled, but no signatures found".
metadata_refs=$(
  printf '%s\n' "$repo_refs" | awk -F/ '
    NF == 1 && $1 == "ostree-metadata" { print }
  '
)

for unsigned_ref in $appstream_refs $metadata_refs; do
  if ! unsigned_commit=$(ostree rev-parse --repo="$repo_dir" "$unsigned_ref"); then
    echo "Unable to resolve Flatpak metadata ref: $unsigned_ref" >&2
    exit 1
  fi
  if [ -n "${GNUPGHOME:-}" ]; then
    ostree gpg-sign --repo="$repo_dir" --gpg-homedir="$GNUPGHOME" \
      "$unsigned_commit" "$FLATPAK_GPG_KEY"
  else
    ostree gpg-sign --repo="$repo_dir" \
      "$unsigned_commit" "$FLATPAK_GPG_KEY"
  fi
done

flatpak build-update-repo --no-update-appstream "$@" \
  --gpg-import="$staged_public_key" "$repo_dir"

# Assert the signed metadata here, where the cause is still in scope, rather
# than leaving it to the CI step that can only report a missing file. The index
# shard is named by the digest of summary.idx, so an index left over from an
# earlier pass is caught alongside one that was never generated.
for signed_metadata in summary summary.sig summary.idx summary.idx.sig; do
  if [ ! -s "$repo_dir/$signed_metadata" ]; then
    echo "build-update-repo produced no $signed_metadata; refusing to publish." >&2
    exit 1
  fi
done
summary_index_sha=$(sha256sum "$repo_dir/summary.idx" | cut -d ' ' -f1)
if [ ! -s "$repo_dir/summaries/$summary_index_sha.idx.sig" ]; then
  echo "Summary index has no signature shard summaries/$summary_index_sha.idx.sig." >&2
  exit 1
fi

# Build beside the published filename and replace it only after Flatpak has
# produced a complete signed bundle. A failed signing pass leaves the existing
# unsigned local-build artifact intact, and CI will fail before deployment.
bundle_stage_dir=$(mktemp -d "$release_dir/.flatpak-sign.XXXXXX")
signed_bundle="$bundle_stage_dir/$(basename -- "$bundle")"
cleanup() {
  rm -f -- "$signed_bundle"
  rmdir -- "$bundle_stage_dir" 2>/dev/null || true
  cleanup_key_stage
}
trap cleanup 0 1 2 15

flatpak build-bundle \
  --repo-url="$ARMADA_FLATPAK_REPO_URL" \
  --gpg-keys="$staged_public_key" \
  "$repo_dir" "$signed_bundle" buzz.armada.app stable

# Only expose the publisher identity and replace the install artifact after
# every signing operation and the complete bundle build have succeeded.
mv -f -- "$signed_bundle" "$bundle"
mv -f -- "$staged_public_key" "$published_public_key"
mv -f -- "$staged_fingerprint" "$published_fingerprint"

trap - 0 1 2 15
rmdir -- "$key_stage_dir"
rmdir -- "$bundle_stage_dir"

echo "Signed Flatpak bundle: $bundle"
echo "Signed update repository: $repo_dir"

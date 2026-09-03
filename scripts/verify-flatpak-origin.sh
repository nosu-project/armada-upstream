#!/usr/bin/env bash
#
# Verify that the public Flatpak OSTree origin actually SERVES the repository,
# rather than the nsite gateway's SPA index.html fallback.
#
# This is the guard against the exact failure that shipped once. The signed
# OSTree repository was never published to https://armada.buzz/downloads/flatpak/,
# so the nsite gateway answered every path under it with index.html and HTTP 200.
# OSTree fetched `/summary`, parsed HTML as a summary, found nothing newer than
# the running commit, and the in-place Flatpak update silently never happened —
# while the kind-30622 release event correctly advertised the new version. A
# green deploy hid a dead update path. This makes that state a loud failure.
#
# Usage: verify-flatpak-origin.sh <origin-url> <local-repo-dir> [--exact]
#
# The core check is shadow detection, and it does NOT depend on which version is
# live: the gateway serves the SAME index.html for every MISSING path, so a
# repository file that hashes equal to that fallback (or is HTML at all) is one
# the gateway isn't really serving. Robust to the release/deploy-nsite race,
# which can leave either writer's repository live for a moment.
#
# --exact ADDS a freshness assertion: the served bytes must be the very ones in
# <local-repo-dir>. The release path uses it to prove the newest repository is
# live the moment the release finishes; deploy-nsite omits it, because on a
# release commit it may (briefly, harmlessly) have published the previous repo.
#
# curl + sha256 only: no OSTree, no key, no secrets. It runs on the plain Linux
# CI runner, and touches only public bytes, so it is safe to run from the
# working tree after the signing key has been destroyed.
set -euo pipefail

origin="${1:?usage: verify-flatpak-origin.sh <origin-url> <local-repo-dir> [--exact]}"
repo="${2:?usage: verify-flatpak-origin.sh <origin-url> <local-repo-dir> [--exact]}"
mode="${3:-}"
origin="${origin%/}"

test -s "$repo/summary"

exact=0
if [ "$mode" = "--exact" ]; then
  exact=1
elif [ -n "$mode" ]; then
  echo "unknown argument: $mode" >&2
  exit 2
fi

# summary + its signatures are what OSTree fetches first, and their path names
# are STABLE across repository versions — so they detect the SPA shadow whether
# or not the served repo is the exact one built here. Only paths that exist
# locally are checked, so a repository built without static deltas (no
# summary.idx) verifies what it has.
paths=(summary summary.sig summary.idx)
# An object path proves a DEEP path serves real bytes too, but its NAME is the
# object's hash, so it only exists in the served repo when that repo is exactly
# this one. Add it only under --exact, where that is guaranteed; in shadow-only
# mode the served repo may legitimately be a different (newer) version whose
# object filenames differ, and probing this one would false-negative.
if [ "$exact" = "1" ]; then
  obj="$(cd "$repo" && find objects -type f 2>/dev/null | sort | head -1 || true)"
  [ -n "$obj" ] && paths+=("$obj")
fi

fetch() { curl -fsSL --max-time 120 -o "$2" "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

verify_once() {
  # Capture the gateway's fallback (if it uses one): a 200 for a path that
  # cannot exist is the SPA index.html every shadowed path also returns. A host
  # that answers missing paths with a real 404 leaves this empty, and the
  # per-file fetch below then fails honestly on an absent file instead.
  local fb="" tmp
  tmp="$(mktemp)"
  if fetch "$origin/__nsite_flatpak_probe_${RANDOM}${RANDOM}" "$tmp"; then
    fb="$(sha "$tmp")"
    echo "  (host serves a 200 fallback for missing paths; guarding against it)"
  fi
  rm -f "$tmp"

  local rel want have got
  for rel in "${paths[@]}"; do
    [ -s "$repo/$rel" ] || continue
    got="$(mktemp)"
    if ! fetch "$origin/$rel" "$got"; then
      rm -f "$got"
      echo "  $rel: not served yet"
      return 1
    fi
    # The shipped-once failure served index.html for the summary itself.
    if head -c 64 "$got" | grep -qiE '<!doctype|<html'; then
      rm -f "$got"
      echo "  $rel: served HTML, not a repository file"
      return 1
    fi
    have="$(sha "$got")"
    rm -f "$got"
    if [ -n "$fb" ] && [ "$have" = "$fb" ]; then
      echo "  $rel: served the SPA fallback, not the file"
      return 1
    fi
    if [ "$exact" = "1" ]; then
      want="$(sha "$repo/$rel")"
      if [ "$want" != "$have" ]; then
        echo "  $rel: served bytes are not the published ones (want $want, got $have)"
        return 1
      fi
    fi
    echo "  $rel: ok"
  done
  return 0
}

# A published manifest takes a little while to reach the gateway and its blobs
# to replicate across Blossom, so allow a bounded propagation window before
# treating a mismatch as the real, shipped-once failure.
attempts="${VERIFY_ATTEMPTS:-15}"
delay="${VERIFY_DELAY:-30}"
for attempt in $(seq 1 "$attempts"); do
  echo "verifying $origin (attempt $attempt/$attempts, exact=$exact)"
  if verify_once; then
    echo "origin serves the Flatpak repository."
    exit 0
  fi
  [ "$attempt" -lt "$attempts" ] && sleep "$delay"
done

echo "ERROR: $origin is not correctly serving the Flatpak repository." >&2
echo "The in-place Flatpak update path would be broken; failing loudly rather than shipping it." >&2
exit 1

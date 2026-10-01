#!/bin/sh
# Build and publish the armada-ci runner image on the ngit-ci coordinator host.
#
# Run from a checkout of this repo (any commit-ish; defaults to HEAD):
#   .ngit/ci-image/build.sh [ref]
#
# Doing build + push + stale-volume removal as ONE step exists for two learned
# reasons:
#   1. Stale-registry race: the coordinator's act pulls
#      localhost:5000/armada-ci:latest at job start. Building locally without
#      pushing (or with a delayed push) means a release triggered in between
#      runs on the OLD image — this is how v0.39.6's Google Play publish hit
#      "fastlane: command not found" minutes before the push completed.
#   2. Stale act-toolcache volume: act mounts the persistent `act-toolcache`
#      docker volume over /opt/hostedtoolcache in every job container. It is
#      seeded from the image only while EMPTY, so after an image rebuild the
#      old volume shadows any new/changed toolcache content until removed.
#      Removing it here makes the next job re-seed it from the new image.
#
# The image carries no dependency caches. The coordinator mounts them into
# every job as persistent volumes, via NGIT_CI_ACT_CONTAINER_OPTIONS in
# /opt/ngit-ci/.env:
#   -v ci-gradle:/root/.gradle -v ci-npm:/root/.npm
#   -v ci-electron:/root/.cache/electron
#   -v ci-electron-builder:/root/.cache/electron-builder
#   -v ci-cargo-registry:/root/.cargo/registry -v ci-cargo-git:/root/.cargo/git
#   -v ci-cargo-target:/root/.cargo-target
# Concurrent jobs share them safely (Gradle, npm and cargo all lock their
# stores). To reset one, `docker volume rm` it while no job is running.
set -eu

ref="${1:-HEAD}"
registry="${ARMADA_CI_REGISTRY:-localhost:5000}"
tag="$registry/armada-ci:latest"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

ctx="$(mktemp -d /tmp/armada-ci-context.XXXXXX)"
trap 'rm -rf "$ctx"' EXIT

# The Dockerfile copies nothing from the repo, so the context is just itself.
git archive "$ref" .ngit/ci-image/Dockerfile | tar -x -C "$ctx"
mv "$ctx/.ngit/ci-image/Dockerfile" "$ctx/Dockerfile"

docker build -t "$tag" "$ctx"
docker push "$tag"

# Drop the stale toolcache volume so the next job re-seeds it from this image.
# Refuse only if a job container is actively using it right now.
if docker ps --format '{{.Names}}' | grep -q '^act-'; then
  echo "WARNING: act job container(s) running; NOT removing act-toolcache." >&2
  echo "Re-run 'docker volume rm act-toolcache' once they finish." >&2
else
  docker volume rm act-toolcache 2>/dev/null || true
fi

echo "Published $tag"

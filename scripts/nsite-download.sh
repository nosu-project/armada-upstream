#!/usr/bin/env bash
#
# Download a named nsite's files, skipping Blossom mirrors that are down.
#
# Usage: nsite-download.sh <site-name> <output-dir> [extra `nsyte download` args]
#
# Environment:
#   NSYTE_BUNKER             required — resolves whose site (the signing pubkey)
#   NSITE_CONFIG             relays/servers source, default .nsite/config.json
#   NSITE_DOWNLOAD_TIMEOUT   seconds for the whole download, default 600
#
# Exit status: 0 on success; 3 when no server or no relay is reachable (the
# caller decides whether a missing download is fatal — for the Flatpak fold
# it is not); 124/137 when the timeout fired; otherwise nsyte's own status.
# Callers keep their own completeness gates on the output directory: a
# non-zero status here is "not proven complete", never "partially usable".
#
# The probe and the bound are both load-bearing. `nsyte download` fetches each
# blob with a `fetch()` that has NO timeout and tries servers in order, so a
# mirror that accepts the connection and never answers hangs every file on
# it — that is how a single downed host thrashed until the runner was
# OOM-killed, and a SIGKILL runs none of the caller's fallback. Only hosts
# that answer are handed to nsyte, and `timeout` is the backstop for one that
# answers the probe and then wedges mid-transfer.
set -euo pipefail

name="${1:?usage: nsite-download.sh <site-name> <output-dir> [nsyte download args...]}"
out="${2:?usage: nsite-download.sh <site-name> <output-dir> [nsyte download args...]}"
shift 2

: "${NSYTE_BUNKER:?NSYTE_BUNKER is not set; ask the ngit-ci operator to provision it for the #ALIAS of this repo.}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="${NSITE_CONFIG:-.nsite/config.json}"
run_timeout="${NSITE_DOWNLOAD_TIMEOUT:-600}"

read_list() {
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((c[process.argv[2]]||[]).join(","))' "$config" "$1"
}
relays="$(read_list relays)"
servers="$(read_list servers)"
if [ -z "$relays" ] || [ -z "$servers" ]; then
  echo "nsite-download: $config lists no relays or no servers" >&2
  exit 1
fi

echo "Probing Blossom servers..."
live_servers="$("$here/live-hosts.sh" "$servers")"
echo "Probing relays..."
live_relays="$("$here/live-hosts.sh" "$relays")"

if [ -z "$live_servers" ] || [ -z "$live_relays" ]; then
  echo "nsite-download: no reachable Blossom server / relay to download $name from." >&2
  exit 3
fi
echo "nsyte download $name -> $out servers=$live_servers relays=$live_relays"

mkdir -p "$out"
set +e
timeout --signal=TERM --kill-after=30 "$run_timeout" \
  nsyte download \
    --name "$name" \
    --relays "$live_relays" \
    --servers "$live_servers" \
    --sec "$NSYTE_BUNKER" \
    --output "$out" \
    "$@"
status=$?
set -e

case "$status" in
  0) ;;
  124|137) echo "nsite-download: exceeded ${run_timeout}s and was killed (rc=$status)." >&2 ;;
  *) echo "nsite-download: nsyte exited $status." >&2 ;;
esac
exit "$status"

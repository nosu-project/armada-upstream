#!/usr/bin/env bash
# Run the Armada desktop shell against the Vite dev server (`npm run
# electron:dev`).
#
# Starts Vite, waits for it to serve, then launches Electron pointed at it via
# ARMADA_DEV_URL. The renderer gets HMR and React fast refresh; the shell around
# it — tray, screen-share picker, safeStorage login store, the SQLite ArmadaDB —
# is the same electron/main.js the packaged app runs, so desktop-only paths are
# actually exercised. Ctrl-C tears down both processes.
#
# Two things this deliberately does NOT share with an installed Armada:
#
#   • The profile. --user-data-dir points at electron/.dev-profile, so a
#     work-in-progress build cannot write the real armada.db — which holds
#     decrypted Concord and NIP-17 history that exists nowhere else. Override
#     with ARMADA_DEV_USER_DATA if you deliberately want the real one.
#   • The origin. Dev is http://localhost:PORT, the packaged app is
#     app://armada, and localStorage (so the login store) is per-origin. You
#     log in again here; that is the same separation the profile gives.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

HOST="localhost"
PORT="${PORT:-8080}"
URL="http://${HOST}:${PORT}/"
USER_DATA="${ARMADA_DEV_USER_DATA:-${ROOT_DIR}/electron/.dev-profile}"

[ -d node_modules ] || npm install --silent

# main.js `require`s ./db.cjs and (through nostrUpdateProvider.js)
# ./updateFeed.cjs at startup, and both are gitignored build artifacts
# (vite.config.electron.ts, vite.config.electron-update.ts). Rebuild every
# launch: they are bundled from src/ and the main process has no HMR, so this is
# the only thing that picks up a store or release-feed change.
npm run build:electron

# The Electron dep tree is electron/'s own (electron/package.json), not the web
# app's.
ELECTRON="${ROOT_DIR}/electron/node_modules/.bin/electron"
if [ ! -x "${ELECTRON}" ]; then
  echo "Installing Electron dependencies ..."
  (cd electron && npm ci --no-audit --no-fund)
fi

mkdir -p "${USER_DATA}"

# Probe the port BEFORE starting Vite. The readiness wait below cannot tell our
# dev server from someone else's (a stray `npm run dev`) — it would see the
# other one answer, point Electron at it, and only then notice ours had exited
# on --strictPort.
if (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null; then
  echo "Something is already listening on ${HOST}:${PORT} (another \`npm run dev\`?)." >&2
  echo "Stop it, or run with PORT=<other>." >&2
  exit 1
fi

# --strictPort: fail loudly on a taken port rather than serving somewhere
# ARMADA_DEV_URL doesn't point.
npm exec -- vite --host "${HOST}" --port "${PORT}" --strictPort &
VITE_PID=$!

ELECTRON_PID=""
cleanup() {
  trap - INT TERM EXIT
  [ -n "${ELECTRON_PID}" ] && kill "${ELECTRON_PID}" 2>/dev/null || true
  kill "${VITE_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Wait for the dev server to accept connections (~30s), bailing out early if
# Vite died (a taken port under --strictPort exits immediately).
echo "Waiting for Vite at ${URL} ..."
ready() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null "${URL}"
  else
    (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null
  fi
}
for _ in $(seq 1 60); do
  if ready; then break; fi
  if ! kill -0 "${VITE_PID}" 2>/dev/null; then
    echo "Vite exited before becoming ready." >&2
    exit 1
  fi
  sleep 0.5
done

echo "Launching Electron -> ${URL}"
ARMADA_DEV_URL="${URL}" "${ELECTRON}" "${ROOT_DIR}/electron" \
  --user-data-dir="${USER_DATA}" &
ELECTRON_PID=$!

# Exit when either process exits. Polled rather than `wait -n`, which needs
# bash 4.3 — macOS still ships 3.2 as /bin/bash.
while kill -0 "${VITE_PID}" 2>/dev/null && kill -0 "${ELECTRON_PID}" 2>/dev/null; do
  sleep 1
done

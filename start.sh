#!/usr/bin/env sh
# Turnkey bootstrap for the Armada stack (relay + LiveKit + client).
#
#   ./start.sh            # generate secrets on first run, build, start, health-check
#   ./start.sh down       # stop the stack (data volume is kept)
#   ./start.sh clean      # stop and DELETE all data (relay DB, groups, invites)
#
# Requirements: docker with the compose plugin. Nothing else.
set -eu

cd "$(dirname "$0")/infra"

# ── helpers ───────────────────────────────────────────────────────────────────
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

randhex() {
  # 32 random bytes as hex, without depending on openssl
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

port_free() {
  if command -v ss >/dev/null 2>&1; then
    ! ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  elif command -v nc >/dev/null 2>&1; then
    ! nc -z 127.0.0.1 "$1" 2>/dev/null
  else
    return 0 # can't check; assume free
  fi
}

first_free_port() {
  p=$1
  while ! port_free "$p"; do
    p=$((p + 1))
    [ $p -gt $(($1 + 20)) ] && die "no free port found near $1"
  done
  echo "$p"
}

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose plugin is not installed"

# ── subcommands ───────────────────────────────────────────────────────────────
case "${1:-up}" in
  down)
    docker compose down
    exit 0
    ;;
  clean)
    docker compose down -v
    say "stack stopped and data volume removed"
    exit 0
    ;;
  up) ;;
  *)
    die "usage: ./start.sh [up|down|clean]"
    ;;
esac

# ── .env bootstrap ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "no infra/.env found — generating one with fresh secrets"

  # The human admin's pubkey cannot be auto-generated; it identifies who owns
  # the community. Prompt for it (npub or 64-char hex; comma-separated for
  # multiple admins). Allow ADMIN_PUBKEY to be preset in the environment for
  # non-interactive installs.
  ADMIN_PUBKEY=${ADMIN_PUBKEY:-}
  while [ -z "$ADMIN_PUBKEY" ]; do
    if [ ! -t 0 ]; then
      die "ADMIN_PUBKEY is required: set it in the environment or run interactively. It is the community admin's Nostr pubkey (npub or 64-char hex)."
    fi
    printf 'Community admin pubkey (npub or hex, comma-separated for multiple): '
    read -r ADMIN_PUBKEY
  done

  RELAY_PRIVKEY=$(randhex)
  LIVEKIT_API_SECRET=$(randhex)
  CLIENT_PORT=$(first_free_port 8080)
  [ "$CLIENT_PORT" != "8080" ] && say "port 8080 is busy; using $CLIENT_PORT for the client"
  # Escape characters that are special to sed's replacement (commas are fine).
  ADMIN_PUBKEY_ESC=$(printf '%s' "$ADMIN_PUBKEY" | sed 's/[&/\]/\\&/g')
  sed \
    -e "s/^RELAY_PRIVKEY=$/RELAY_PRIVKEY=$RELAY_PRIVKEY/" \
    -e "s/^LIVEKIT_API_SECRET=$/LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET/" \
    -e "s/^ADMIN_PUBKEY=$/ADMIN_PUBKEY=$ADMIN_PUBKEY_ESC/" \
    -e "s/^CLIENT_PORT=8080$/CLIENT_PORT=$CLIENT_PORT/" \
    .env.example > .env
  chmod 600 .env
  say "wrote infra/.env (keep it safe — RELAY_PRIVKEY is the relay's identity)"
else
  say "using existing infra/.env"
fi

CLIENT_PORT=$(grep '^CLIENT_PORT=' .env | cut -d= -f2)
CLIENT_PORT=${CLIENT_PORT:-8080}

# ── build & start ─────────────────────────────────────────────────────────────
say "building and starting the stack (first build takes a few minutes)"
docker compose up -d --build

# ── health checks ─────────────────────────────────────────────────────────────
wait_for() {
  label=$1; url=$2; expect=$3
  i=0
  while [ $i -lt 30 ]; do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
    if [ "$code" = "$expect" ]; then
      say "$label is up ($url)"
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  printf '\033[1;33mwarn:\033[0m %s did not respond at %s (last status: %s)\n' "$label" "$url" "${code:-none}"
  return 1
}

ok=0
wait_for "relay (NIP-11)"      "http://localhost:5577"                          200 || ok=1
wait_for "relay (NIP-29 AV)"   "http://localhost:5577/.well-known/nip29/livekit" 204 || ok=1
wait_for "livekit"             "http://localhost:7880"                          200 || ok=1
wait_for "client"              "http://localhost:$CLIENT_PORT"                  200 || ok=1

echo
if [ $ok -eq 0 ]; then
  say "Armada is running"
else
  say "Armada started, but some health checks failed — see: docker compose -f infra/docker-compose.yml logs"
fi
cat <<EOF

  client    http://localhost:$CLIENT_PORT
  relay     ws://localhost:5577   (NIP-11: http://localhost:5577)
  livekit   ws://localhost:7880

  First steps:
    1. Open http://localhost:$CLIENT_PORT and click "Sign up" (generates a key).
    2. The community already exists; you're dropped straight into it.
    3. Click "Join voice" in any channel to test audio (localhost is a
       secure context, so the mic prompt works out of the box).

  Serving beyond localhost? Edit infra/.env (RELAY_DOMAIN,
  RELAY_PUBLIC_BASE_URL, LIVEKIT_PUBLIC_URL, PLATFORM_RELAYS), put your
  internal TLS in front, and run ./start.sh again.
EOF

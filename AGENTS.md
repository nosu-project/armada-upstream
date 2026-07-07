# AGENTS.md

Guidance for agents and operators working on Armada, with a focus on **hosting
it for real users** (beyond the localhost quickstart). The localhost story is in
`README.md`; this file covers production: reverse proxies, single-domain
routing, and getting LiveKit voice to work behind an edge.

## Repo layout

| Path      | What                                                            |
|-----------|-----------------------------------------------------------------|
| `client/` | React 19 + Vite web client (nginx-served static build)          |
| `client/android/`  | Capacitor Android project (signed APK/AAB built in CI) |
| `client/electron/` | Electron desktop shell (loads the hosted client over HTTPS; Linux/Windows/macOS installers built in CI) |
| `server/` | Go relay: khatru + relay29 + badger + LiveKit token endpoint    |
| `infra/`  | `docker-compose.yml` + `.env.example` for the full stack        |
| `start.sh`| Turnkey wrapper around `docker compose` in `infra/`             |

Three containers: `relay` (:5577), `livekit` (:7880 signaling, :7881 TCP,
50000-50100/udp media, optional TURN/TLS), `client` (nginx on :80 → host
`CLIENT_PORT`).

## Build / test

- Client: `cd client && npm install && npm run test` (tsc + eslint + vitest +
  production build).
- Relay: `cd server && RELAY_PRIVKEY=$(openssl rand -hex 32) go run .` —
  or just build the image via `docker compose build relay`.
- Full stack: `./start.sh` (generates `infra/.env` on first run, builds, starts,
  health-checks).

## Secrets

`infra/.env` holds `RELAY_PRIVKEY` and `LIVEKIT_API_SECRET`. It is **gitignored**
(`.gitignore` matches `.env`) — never commit it, never paste its contents into
docs or commits. `RELAY_PRIVKEY` is the relay's Nostr identity; rotating it
orphans all existing groups.

---

## Single-domain hosting (relay + client on one domain)

Armada is designed to run the relay and client on the **same origin** (e.g.
`armada.example.com`), split by path and by WebSocket upgrade. The client
derives the relay's HTTP origin from the relay WS URL (`relayToHttpUrl()` in
`client/src/lib/platform.ts`), so the relay's HTTP endpoints must live under the
same origin.

Set in `infra/.env`:

```
RELAY_DOMAIN=armada.example.com
RELAY_PUBLIC_BASE_URL=https://armada.example.com   # MUST match exactly; used for NIP-98 u-tag checks
PLATFORM_RELAYS=wss://armada.example.com           # client connects the relay WS at the domain root
LIVEKIT_PUBLIC_URL=wss://armada.example.com        # signaling; SDK appends /rtc (see "LiveKit URL gotcha")
```

Reverse-proxy split (reference: Caddy). Route by path + WS upgrade; everything
else is the SPA. A complete, copy-pasteable version lives in
[`infra/Caddyfile.example`](infra/Caddyfile.example):

```caddyfile
armada.example.com {
    tls you@example.com

    # LiveKit signaling websocket. The JS SDK connects to <PUBLIC_URL>/rtc.
    handle /rtc* {
        reverse_proxy SFU_HOST:7880
    }
    # Relay NIP-29 LiveKit token + capability endpoints (NIP-98 authed).
    handle /.well-known/nip29/* {
        reverse_proxy RELAY_HOST:5577
    }
    # Concord AV (CORD-07): blind LiveKit token broker + capability probe.
    # Without this, the request falls through to the SPA (HTML 200) and the
    # client fails with a JSON parse error reading the token.
    handle /.well-known/concord/* {
        reverse_proxy RELAY_HOST:5577
    }
    handle /livekit/* {
        reverse_proxy RELAY_HOST:5577
    }
    # Relay WebSocket (Nostr) + NIP-11 (Accept: application/nostr+json).
    @relay {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    @nip11 header Accept application/nostr+json
    handle @relay  { reverse_proxy RELAY_HOST:5577 }
    handle @nip11  { reverse_proxy RELAY_HOST:5577 }
    # Everything else: the web client SPA.
    handle { reverse_proxy CLIENT_HOST:8080 }
}
```

Caddy per-site `log { output file ... }` blocks fail to **create** a new log
file under some sandbox configs; if a reload errors with `permission denied` on
the log path, `touch` the file and `chown` it to the caddy user first.

### Android App Links (deep linking)

The Android app registers a verified `https` intent filter for **armada.buzz**
(`client/android/app/src/main/AndroidManifest.xml`), so invite/share links open
in the app. Verification requires
`https://armada.buzz/.well-known/assetlinks.json` to be served by the **client**
container (the file lives in `client/public/.well-known/` and ships in the
static build; the Caddy split only routes specific `/.well-known/` prefixes
(`nip29`, `concord`, `armada`) to the relay, so assetlinks falls through to the SPA
container correctly). The file lists the APK signing cert's SHA-256 fingerprint
(get it with `apksigner verify --print-certs Armada.apk`). If the signing key
rotates, or the app is ever published through a store that re-signs (e.g. Play
App Signing), add the new cert fingerprint to the array.

### LiveKit URL gotcha (the #1 voice-breaker)

The LiveKit JS SDK **always appends `/rtc`** to the server URL it's given
(`appendUrlPath(urlObj, 'rtc')`). So:

- Correct: `LIVEKIT_PUBLIC_URL=wss://armada.example.com` → SDK connects to
  `…/rtc` → proxy routes `/rtc*` to the SFU. ✅
- Wrong: `…/rtc` → SDK connects to `…/rtc/rtc` → 404, voice silently fails. ❌

The relay normalizes a trailing `/rtc` away defensively
(`normalizeLivekitURL` in `server/main.go`), but set it correctly anyway.

---

## Voice / LiveKit (the hard part)

WebRTC media is the tricky bit. There are three viable media paths; pick based
on where clients are.

### Keep the LiveKit server protocol in sync with the client SDK (the #2 voice-breaker)

The LiveKit **server image** (`infra/docker-compose.yml`, pinned to an exact
patch like `v1.9.12`) and the **client SDK** (`livekit-client` in
`client/package.json`) negotiate over a versioned signaling protocol. If they
skew — e.g. an old server speaking protocol 15 against a newer client speaking
protocol 17 — the symptom is nasty and non-obvious: signaling connects, then the
client requests `/rtc/v1`, falls back to `/rtc`, fails WebRTC negotiation
(`NegotiationError: negotiation timed out`, `v1 RTC path not found. Consider
upgrading your LiveKit server version`), and **full-reconnects every ~16s** for
every participant. It looks like a network/proxy problem but isn't. When you
bump `livekit-client`, bump the server image to a matching/newer release in the
same change.

### 1. Public SFU (simplest)

If the SFU host has a reachable public IP and you can open UDP 50000-50100 +
TCP 7881 to it, just set `LIVEKIT_USE_EXTERNAL_IP=true` (default). Clients send
media directly. No TURN needed. This is the standard LiveKit deployment.

### 2. LAN clients → direct; external clients → TURN/TLS

This is the reference deployment (SFU on a private LXC, reached through an edge
that only forwards 80/443):

```
LIVEKIT_USE_EXTERNAL_IP=false
LIVEKIT_NODE_IP=<SFU LAN IP, e.g. 192.168.1.150>
LIVEKIT_TURN_ENABLED=true
LIVEKIT_TURN_DOMAIN=turn.example.com
LIVEKIT_CERT_DIR=/abs/path/to/certs/turn   # contains tls.crt + tls.key
LIVEKIT_TURN_PORT=443                       # host port mapped to SFU :443
```

- **LAN clients** get the host candidate `NODE_IP:5xxxx` and connect directly
  over the LAN (low latency, no relay).
- **External clients** can't reach the private `NODE_IP`, so ICE falls back to
  the embedded **TURN/TLS relay** on `turn.example.com:443`.

Apply the production overlay (`infra/docker-compose.prod.yml`), which switches
LiveKit to host networking:

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Run LiveKit with host networking (Docker)

WebRTC media — including the embedded TURN relay's port range — **must not
traverse Docker's bridge NAT**. On a bridge network, relayed media is SNAT'd to
the docker0/bridge gateway (e.g. `172.18.0.1`); the SFU then observes a
peer-reflexive candidate at that gateway IP, ICE selects it, and the media path
**cuts out every ~10 seconds** (`[remote][selected] udp4 prflx 172.18.0.1:...`,
`connectionType: udp` that won't hold). Host networking removes the Docker NAT,
and the SFU then selects a stable `relay` pair (`connectionType: turn`).

`infra/docker-compose.prod.yml` does this. With host networking, LiveKit binds
7880/7881/443 + the media ranges directly on the host, `ports:` are ignored,
and the webhook must reach the relay (which publishes :5577 on the host) via
`http://127.0.0.1:5577`. LiveKit's own docs recommend host networking for
Dockerized deploys for the same reason.

### Do NOT forward UDP through a NAT edge

A tempting-but-broken approach: DNAT/forward UDP 50000-50100 from the public
edge to the SFU over a tunnel (e.g. WireGuard), with MASQUERADE. **This breaks
voice**: MASQUERADE rewrites every client's source to the gateway's tunnel IP,
so the SFU sees all clients as the same address with shifting ports. ICE
candidate pairs thrash ("ice reconnected or switched pair" spam, `prflx
10.0.0.1:...`), connections are unstable, and mobile (where NAT rebinds ports
constantly) drops. Use the TURN/TLS path instead — it preserves per-client
identity and survives mobile/CGNAT/corporate firewalls (this is what Signal
does: prefer direct, relay over TLS/443 when needed).

### TURN/TLS through an HTTPS edge (SNI passthrough)

If your edge terminates TLS for the app (e.g. Caddy on 443), TURN/TLS can't go
through it (TURN is not HTTP). Route the TURN subdomain by **SNI** *before* TLS
termination, passing it through raw to the SFU, which terminates TURN/TLS
itself.

Reference edge: `Cloudflare → nginx (L4 stream, ssl_preread) → WireGuard → SFU`.

```nginx
# nginx.conf (stream module + ssl_preread)
stream {
  map $ssl_preread_server_name $https_upstream {
    turn.example.com   SFU_TUNNEL_IP:443;   # TURN/TLS terminates at the SFU
    default            APP_EDGE_IP:443;     # your app's TLS terminator (caddy)
  }
  server { listen 80;  proxy_pass APP_EDGE_IP:80; }
  server { listen 443; ssl_preread on; proxy_pass $https_upstream; }
}
```

DNS: `turn.example.com` must be **DNS-only / not proxied** (e.g. Cloudflare grey
cloud) so the raw TLS/TURN reaches your edge IP, not Cloudflare's HTTP proxy.

Cert: the SFU terminates TURN/TLS, so it needs a **real, browser-trusted** cert
for `turn.example.com` (self-signed will not work for `turns:`). With
`acme.sh`, TLS-ALPN-01 works nicely because the SNI route already delivers
`turn.example.com:443` to the SFU:

```sh
# Issue (SFU container, port 443 free during issuance):
acme.sh --issue --alpn --tlsport 443 -d turn.example.com --server letsencrypt
acme.sh --install-cert -d turn.example.com --ecc \
  --fullchain-file $CERT_DIR/tls.crt --key-file $CERT_DIR/tls.key \
  --reloadcmd "cd infra && docker compose restart livekit"
```

Renewal needs port 443, which LiveKit holds in production. Run a wrapper that
stops LiveKit, renews via ALPN on 443, then restarts (≈10s voice blip every
~60 days). Note: a 3-level subdomain like `turn.app.example.com` is **not**
covered by Cloudflare's free `*.example.com` edge cert — using your own Let's
Encrypt cert (as above) sidesteps that entirely.

### Verifying voice

- `curl -o /dev/null -w '%{http_code}' https://armada.example.com/.well-known/nip29/livekit` → `204`
- Concord AV broker (CORD-07): `curl -o /dev/null -w '%{http_code}' https://armada.example.com/.well-known/concord/av` → `204` (an HTML/`200` means the proxy is missing the `/.well-known/concord/*` route and the request is hitting the SPA).
- TURN/TLS cert: `openssl s_client -connect turn.example.com:443 -servername turn.example.com` → cert CN matches.
- Watch ICE selection: `docker logs -f infra-livekit-1 | grep -iE "participant active|connectionType|switched pair"`.
  Healthy = a stable selected pair (`connectionType: udp`/`relay`) without
  repeated "switched pair". Relayed external clients should show
  `connectionType: turn` with a `relay <SFU IP>` selected pair. If instead you
  see `prflx 172.18.0.x` (the Docker bridge gateway) cutting out every ~10s,
  LiveKit is on a bridge network — switch it to host networking (see "Run
  LiveKit with host networking"). `prflx <gateway-IP>` from a NAT/MASQUERADE
  edge is the other variant of the same problem (see above).
- "Can't hear myself" is **normal** — WebRTC doesn't loop back your own audio.
  Test with a second participant.

---

## Running Docker inside an unprivileged Proxmox LXC

The reference SFU/relay host is an unprivileged LXC. Pitfalls hit (and fixed):

- **`features: nesting=1,keyctl=1`** required on the container for Docker.
- **runc 1.3.x breaks** with `open sysctl net.ipv4.ip_unprivileged_port_start
  … permission denied` when starting bridge-networked containers in an
  unprivileged userns. Fix: install runc **1.2.x** and point Docker at it via
  `/etc/docker/daemon.json` (`default-runtime` → a runtime whose `path` is the
  1.2.x binary). runc 1.1.x is too old (lacks the time namespace).
- **AppArmor**: Docker's `docker-default` profile can't load in the container
  (`apparmor failed to apply profile … no such file or directory`, also breaks
  `docker build`). Simplest fix: `apt-get purge apparmor` inside the container
  so Docker detects it absent and skips it (acceptable on an internal host).
- **Do not toggle `unprivileged` on an existing rootfs.** Flipping a created
  container between unprivileged/privileged scrambles UID mapping
  (`/root/.ssh` ends up owned by 100000 → SSH pubkey auth silently fails with
  StrictModes). Recreate the container with the desired mode instead.
- Give the container a **static IP** if a reverse proxy targets it by address;
  a changing DHCP lease silently breaks the upstream.

## Networking quick reference (reference deployment)

```
Cloudflare (armada.* orange/proxied; turn.* grey/DNS-only)
  → edge VPS  nginx stream:
       :443 ssl_preread → SNI armada.* ⇒ app TLS terminator (Caddy)
                          SNI turn.*   ⇒ WireGuard ⇒ SFU :443 (TURN/TLS)
       :80/:443 default ⇒ Caddy
  → Caddy (LAN): path-split armada.* → relay :5577 / client :8080 / SFU :7880 (/rtc)
  → SFU LXC: LiveKit (LAN host candidate for LAN clients; TURN/TLS for external)
```

## Conventions

- Commit messages: concise, imperative, sentence case (see `git log`).
- Don't commit `infra/.env`, certs, or any secret material.
- Always commit after finishing a set of changes (don't wait to be asked); do
  not push unless asked. Verify the relay builds (`go build ./...` in `server/`)
  and the client builds (`npm run test` in `client/`) before committing changes
  to those.

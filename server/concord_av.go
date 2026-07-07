package main

import (
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// Concord AV — the CORD-07 blind broker: a LiveKit token endpoint for
// serverless, end-to-end-encrypted Concord v2 communities.
//
// A Concord community has no host, so there is no roster to check. Authority is
// key possession: any member holding a channel's secret derives the channel's
// per-epoch voice keypair (CORD-02 A.6 `concord/voice-signer`) whose x-only
// pubkey IS the SFU room name. To join, the client self-signs a NIP-98-style
// grant (kind 27235) with that key; this endpoint mints a LiveKit JWT after
// verifying only that the grant was signed by the key whose pubkey equals the
// room name. It never learns the community, the membership, or who is joining —
// a stateless, community-agnostic notary. Media is end-to-end encrypted
// client-side under per-sender keys (CORD-07 §3), so the SFU only ever forwards
// ciphertext.
//
//   - GET /.well-known/concord/av          → 204 (capability probe, CORD-07 §2)
//   - GET /.well-known/concord/av/<room>   → { token, url, identity }, grant-authed
//
// where <room> is a 64-char lowercase-hex x-only pubkey.
//
// Blindness makes this an open service by design (anyone can mint a keypair
// and call its pubkey a room), so abuse is bounded without identity: the
// shared per-IP token limiter, a per-room mint limiter, and a short token TTL
// (CORD-07 §2) — never by allow-listing rooms or callers.

// concordAVTokenTTL keeps the bearer JWT short-lived (CORD-07 §2). A LiveKit
// token is only checked at connect; an established call outlives it, and a
// full reconnect after expiry simply re-fetches a grant + token.
const concordAVTokenTTL = time.Hour

// avRoomLimiter caps token mints per ROOM (on top of the per-IP tokenLimiter):
// one room label maps to one channel epoch, so a legitimate call needs a
// handful of mints, while a mint flood against a single room is throttled even
// when distributed across IPs.
var avRoomLimiter = newRateLimiter(0.5, 20)

func setupConcordAV() {
	router := relay.Router()
	router.HandleFunc("/.well-known/concord/av", handleConcordAVCapability)
	router.HandleFunc("/.well-known/concord/av/", tokenLimiter.limit(handleConcordAVToken))
}

// handleConcordAVCapability advertises that this broker speaks Concord AV
// (registered only when LiveKit is configured, so a 204 means "voice works").
func handleConcordAVCapability(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w, r)
	w.WriteHeader(http.StatusNoContent)
}

// verifyAVGrant validates the `Authorization: Concord <base64-event>` grant for
// the given room + URL: a kind-27235 event self-signed by the room-name key
// (pubkey == room — the whole authorization model, only a holder of the channel
// secret can derive that key), fresh, single-use, and targeting this exact
// endpoint. Run as the grant's binding so a wrong-room grant doesn't burn a
// replay-cache slot.
func verifyAVGrant(r *http.Request, room, expectedURL string) bool {
	_, ok := parseAuthGrant(r, "Concord", expectedURL, func(event *nostr.Event) bool {
		return event.PubKey == room
	})
	return ok
}

func handleConcordAVToken(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}

	room := strings.TrimPrefix(r.URL.Path, "/.well-known/concord/av/")
	if !nostr.IsValid32ByteHex(room) {
		http.Error(w, "invalid room", http.StatusBadRequest)
		return
	}
	if !avRoomLimiter.allow(room) {
		corsHeaders(w, r)
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}

	expectedURL := s.PublicBaseURL + "/.well-known/concord/av/" + room
	if !verifyAVGrant(r, room, expectedURL) {
		http.Error(w, "invalid voice grant", http.StatusUnauthorized)
		return
	}

	// The broker-assigned SFU identity (CORD-07 §2): fully random, 128 bits.
	// The identity feeds the per-sender frame-key derivation (§3), so a
	// collision would merge two publishers onto one key and one IV space —
	// 64 bits of birthday margin is too thin to stake that on, 128 isn't.
	raw := make([]byte, 16)
	if _, err := randRead(raw); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	identity := hex.EncodeToString(raw)

	writeTokenResponse(w, identity, room, concordAVTokenTTL, "concord av token")
}

// Concord voice presence intentionally rides Concord's own ephemeral kind-23313
// events over the channel's stream address (client-side, CORD-07 §4), NOT the
// relay's kind-39004 webhook path — the broker must stay ignorant of the
// community, so it cannot map a room to a group. The LiveKit webhook still
// feeds the in-memory `rooms` registry, but those entries are keyed by the
// opaque room name and are never surfaced for Concord (no group id to query by).

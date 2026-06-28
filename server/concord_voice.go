package main

import (
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/nbd-wtf/go-nostr"
)

// Concord voice — a "blind broker" LiveKit token endpoint for serverless,
// end-to-end-encrypted Concord communities.
//
// Concord communities have no host, so there is no roster to check. Authority
// is key possession: any member holding a channel's key derives a per-(channel,
// epoch) secp256k1 signing key whose x-only pubkey IS the LiveKit room name.
// To join voice the client self-signs a short NIP-98-style grant with that key;
// this endpoint mints a LiveKit JWT after verifying only that the grant was
// signed by the key whose pubkey equals the room name. It never learns the
// community, the membership, or who is in the room — it is a stateless,
// community-agnostic notary. Media is end-to-end encrypted client-side (the SFU
// forwards ciphertext it cannot decode), so even the SFU operator hears nothing.
//
//   - GET /.well-known/concord/voice              → 204 (capability discovery)
//   - GET /.well-known/concord/voice/<room>       → LiveKit JWT, grant-authed
//
// where <room> is a 64-char lowercase-hex x-only pubkey.

func setupConcordVoice() {
	router := relay.Router()
	router.HandleFunc("/.well-known/concord/voice", handleConcordVoiceCapability)
	router.HandleFunc("/.well-known/concord/voice/", tokenLimiter.limit(handleConcordVoiceToken))
}

// handleConcordVoiceCapability advertises that this broker speaks Concord voice
// (registered only when LiveKit is configured, so a 204 means "voice works").
func handleConcordVoiceCapability(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w, r)
	w.WriteHeader(http.StatusNoContent)
}

// verifyVoiceGrant validates the `Authorization: Concord <base64-event>` grant
// for the given room + URL. The grant is a kind-27235 event self-signed by the
// room-name key; we verify it was signed by exactly that key (pubkey == room),
// is fresh, and targets this endpoint. Authorization is "the signer holds the
// channel key", proven by the signature — no community lookup.
func verifyVoiceGrant(r *http.Request, room, expectedURL string) bool {
	// Bind the grant to the room: it must be signed by the key whose x-only
	// pubkey is the room name (the whole authorization model — only a holder of
	// the channel key can derive this key), and any `room` tag must echo it.
	// Run as the grant's binding so a wrong-room grant doesn't burn a
	// replay-cache slot.
	_, ok := parseAuthGrant(r, "Concord", expectedURL, func(event *nostr.Event) bool {
		if event.PubKey != room {
			return false
		}
		roomTag := event.Tags.GetFirst([]string{"room", ""})
		return roomTag == nil || (*roomTag)[1] == room
	})
	return ok
}

func handleConcordVoiceToken(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}

	room := strings.TrimPrefix(r.URL.Path, "/.well-known/concord/voice/")
	if !nostr.IsValid32ByteHex(room) {
		http.Error(w, "invalid room", http.StatusBadRequest)
		return
	}

	expectedURL := s.PublicBaseURL + "/.well-known/concord/voice/" + room
	if !verifyVoiceGrant(r, room, expectedURL) {
		http.Error(w, "invalid voice grant", http.StatusUnauthorized)
		return
	}

	// The LiveKit participant identity: the user's real pubkey (display only,
	// from an untrusted header — the broker does NOT gate on it) plus a random
	// suffix so the same person can join from multiple devices. If the header
	// is missing or malformed, fall back to a fully random identity.
	display := r.Header.Get("X-Concord-Identity")
	if !nostr.IsValid32ByteHex(display) {
		display = ""
	}
	suffix := make([]byte, 8)
	if _, err := randRead(suffix); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	identity := display + "-" + hex.EncodeToString(suffix)
	if display == "" {
		identity = hex.EncodeToString(suffix)
	}

	writeTokenResponse(w, identity, room, "concord voice token")
}

// concord voice presence intentionally rides Concord's own kind-3306 events
// over the channel pseudonym (client-side), NOT the relay's kind-39004 webhook
// path — the relay must stay ignorant of the community, so it cannot map a room
// to a group. mintLivekitToken + the LiveKit webhook still drive the in-memory
// `rooms` registry, but those entries are keyed by the opaque room name and are
// never surfaced for Concord (no group id to query by).

package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
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

var hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

func setupConcordVoice() {
	router := relay.Router()
	router.HandleFunc("/.well-known/concord/voice", handleConcordVoiceCapability)
	router.HandleFunc("/.well-known/concord/voice/", tokenLimiter.limit(handleConcordVoiceToken))
}

// handleConcordVoiceCapability advertises that this broker speaks Concord voice
// (registered only when LiveKit is configured, so a 204 means "voice works").
func handleConcordVoiceCapability(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	w.WriteHeader(http.StatusNoContent)
}

// verifyVoiceGrant validates the `Authorization: Concord <base64-event>` grant
// for the given room + URL. The grant is a kind-27235 event self-signed by the
// room-name key; we verify it was signed by exactly that key (pubkey == room),
// is fresh, and targets this endpoint. Authorization is "the signer holds the
// channel key", proven by the signature — no community lookup.
func verifyVoiceGrant(r *http.Request, room, expectedURL string) bool {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Concord ") {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Concord "))
	if err != nil {
		return false
	}
	var event nostr.Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return false
	}
	if event.Kind != kindHTTPAuth {
		return false
	}
	// The binding: the grant must be signed by the key whose x-only pubkey is
	// the room name. This is the whole authorization model — only a holder of
	// the channel key can derive this key and sign for this room.
	if event.PubKey != room {
		return false
	}
	if ok, err := event.CheckSignature(); !ok || err != nil {
		return false
	}
	now := nostr.Now()
	if event.CreatedAt < now-60 || event.CreatedAt > now+60 {
		return false
	}
	uTag := event.Tags.GetFirst([]string{"u", ""})
	if uTag == nil || (*uTag)[1] != expectedURL {
		return false
	}
	methodTag := event.Tags.GetFirst([]string{"method", ""})
	if methodTag != nil && !strings.EqualFold((*methodTag)[1], r.Method) {
		return false
	}
	// Optional room tag, if present, must echo the room name.
	roomTag := event.Tags.GetFirst([]string{"room", ""})
	if roomTag != nil && (*roomTag)[1] != room {
		return false
	}
	// Single-use: reject a grant whose id we've already honored within its
	// freshness window (anti-replay). Use the computed id (not the wire `id`
	// field, which the client controls and could omit/forge) so a replay can't
	// dodge the cache by mutating only the id. Checked last so we only consume
	// the id for an otherwise-valid grant.
	if rememberGrant(event.GetID()) {
		return false
	}
	return true
}

func handleConcordVoiceToken(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	room := strings.TrimPrefix(r.URL.Path, "/.well-known/concord/voice/")
	if !hex64Re.MatchString(room) {
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
	if !hex64Re.MatchString(display) {
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

	jwt, err := mintLivekitToken(identity, room)
	if err != nil {
		log.Error().Err(err).Msg("failed to mint concord voice token")
		http.Error(w, "failed to mint token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": jwt,
		"url":   s.LivekitURL,
	})
}

// concord voice presence intentionally rides Concord's own kind-3306 events
// over the channel pseudonym (client-side), NOT the relay's kind-39004 webhook
// path — the relay must stay ignorant of the community, so it cannot map a room
// to a group. mintLivekitToken + the LiveKit webhook still drive the in-memory
// `rooms` registry, but those entries are keyed by the opaque room name and are
// never surfaced for Concord (no group id to query by).


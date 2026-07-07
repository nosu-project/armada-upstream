package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/nbd-wtf/go-nostr"
)

// Shared machinery for the LiveKit token endpoints (NIP-29 group and DM
// voice). The handlers differ only in how they authorize the caller and
// build the participant identity; the auth-event parsing, freshness/anti-replay
// checks, OPTIONS/CORS preamble, and JSON response are identical and live here.

// preflight writes CORS headers and, for an OPTIONS request, the 204 short
// circuit. It returns true when the request was a preflight and the caller
// should stop (the response is already written).
func preflight(w http.ResponseWriter, r *http.Request) bool {
	corsHeaders(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	return false
}

// writeTokenResponse mints a LiveKit JWT for the identity/room and writes it as
// the JSON body the token endpoints share. On a minting failure it logs
// with `what` for context and writes a 500.
func writeTokenResponse(w http.ResponseWriter, identity, room, what string) {
	jwt, err := mintLivekitToken(identity, room)
	if err != nil {
		log.Error().Err(err).Msg("failed to mint " + what)
		http.Error(w, "failed to mint token", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": jwt,
		"url":   s.LivekitURL,
	})
}

// parseAuthGrant decodes an `Authorization: <scheme> <base64-event>` header into
// a verified kind-27235 auth event, applying every check the grant scheme
// requires: scheme prefix, base64/JSON decode, kind, signature, the ±60s freshness
// window, the `u`-tag (must equal expectedURL) and `method`-tag (must match the
// request method), and finally single-use anti-replay on the computed id.
//
// `bind`, if non-nil, runs caller-specific authorization (group membership or
// DM participant) on the otherwise-valid event and must
// return true to accept. It is invoked *before* the anti-replay check so a
// grant that fails the binding does not burn a replay-cache slot — preserving
// the "only consume the id for an accepted grant" guarantee.
func parseAuthGrant(r *http.Request, scheme, expectedURL string, bind func(*nostr.Event) bool) (*nostr.Event, bool) {
	header := r.Header.Get("Authorization")
	prefix := scheme + " "
	if !strings.HasPrefix(header, prefix) {
		return nil, false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, prefix))
	if err != nil {
		return nil, false
	}
	var event nostr.Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil, false
	}
	if event.Kind != kindHTTPAuth {
		return nil, false
	}
	if ok, err := event.CheckSignature(); !ok || err != nil {
		return nil, false
	}
	now := nostr.Now()
	if event.CreatedAt < now-60 || event.CreatedAt > now+60 {
		return nil, false
	}
	uTag := event.Tags.GetFirst([]string{"u", ""})
	if uTag == nil || (*uTag)[1] != expectedURL {
		return nil, false
	}
	methodTag := event.Tags.GetFirst([]string{"method", ""})
	if methodTag != nil && !strings.EqualFold((*methodTag)[1], r.Method) {
		return nil, false
	}
	if bind != nil && !bind(&event) {
		return nil, false
	}
	// Single-use: reject a grant whose id we've already honored within its
	// freshness window (anti-replay). Use the computed id (not the wire `id`
	// field, which the client controls and could omit/forge) so a replay can't
	// dodge the cache by mutating only the id. Checked last so we only consume
	// the id for an otherwise-valid grant.
	if rememberGrant(event.GetID()) {
		return nil, false
	}
	return &event, true
}

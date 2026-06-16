package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/webhook"
	"github.com/nbd-wtf/go-nostr"
)

// LiveKit integration per NIP-29 "Live audio/video (AV) spaces":
//
//   - GET /.well-known/nip29/livekit              → 204 (capability discovery)
//   - GET /.well-known/nip29/livekit/<group-id>   → LiveKit JWT, NIP-98 auth
//   - POST /livekit/webhook                       → LiveKit webhooks drive
//     kind 39004 participant events (relay-signed, broadcast + queryable)
const kindHTTPAuth = 27235
const kindGroupParticipants = 39004

var (
	roomsMu sync.RWMutex
	// groupId -> participant identity -> pubkey
	rooms = map[string]map[string]string{}
)

func setupLivekit() {
	router := relay.Router()
	router.HandleFunc("/.well-known/nip29/livekit", handleLivekitCapability)
	// DM voice rooms are not NIP-29 groups; they live at a separate path and
	// authorize by participant pubkey rather than group membership. Register
	// the more specific prefix first so it isn't shadowed by the group route.
	router.HandleFunc("/.well-known/nip29/livekit-dm/", handleLivekitDMToken)
	router.HandleFunc("/.well-known/nip29/livekit/", handleLivekitToken)
	router.HandleFunc("/livekit/webhook", handleLivekitWebhook)

	// Serve kind 39004 (participants) queries from the in-memory room state.
	relay.QueryEvents = append(relay.QueryEvents, func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
		ch := make(chan *nostr.Event, 1)
		go func() {
			defer close(ch)
			for _, kind := range filter.Kinds {
				if kind != kindGroupParticipants {
					continue
				}
				ids := filter.Tags["d"]
				if len(ids) == 0 {
					roomsMu.RLock()
					for groupId := range rooms {
						ids = append(ids, groupId)
					}
					roomsMu.RUnlock()
				}
				for _, groupId := range ids {
					if evt := participantsEvent(groupId); evt != nil {
						ch <- evt
					}
				}
			}
		}()
		return ch, nil
	})
}

func corsHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
}

func handleLivekitCapability(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// verifyNip98 validates the `Authorization: Nostr <base64-event>` header for
// the given URL and returns the authenticated pubkey.
func verifyNip98(r *http.Request, expectedURL string) (string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Nostr ") {
		return "", false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(header, "Nostr "))
	if err != nil {
		return "", false
	}
	var event nostr.Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return "", false
	}
	if event.Kind != kindHTTPAuth {
		return "", false
	}
	if ok, err := event.CheckSignature(); !ok || err != nil {
		return "", false
	}
	now := nostr.Now()
	if event.CreatedAt < now-60 || event.CreatedAt > now+60 {
		return "", false
	}
	uTag := event.Tags.GetFirst([]string{"u", ""})
	if uTag == nil || (*uTag)[1] != expectedURL {
		return "", false
	}
	methodTag := event.Tags.GetFirst([]string{"method", ""})
	if methodTag != nil && !strings.EqualFold((*methodTag)[1], r.Method) {
		return "", false
	}
	return event.PubKey, true
}

func handleLivekitToken(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	groupId := strings.TrimPrefix(r.URL.Path, "/.well-known/nip29/livekit/")
	if groupId == "" {
		http.Error(w, "missing group id", http.StatusBadRequest)
		return
	}

	group, _ := state.Groups.Load(groupId)
	if group == nil {
		http.Error(w, "group not found", http.StatusNotFound)
		return
	}

	expectedURL := s.PublicBaseURL + "/.well-known/nip29/livekit/" + groupId
	pubkey, ok := verifyNip98(r, expectedURL)
	if !ok {
		http.Error(w, "invalid NIP-98 authorization", http.StatusUnauthorized)
		return
	}

	// Access control: private or closed groups require membership.
	if group.Private || group.Closed {
		if _, isMember := group.Members[pubkey]; !isMember {
			http.Error(w, "restricted: not a member of this group", http.StatusForbidden)
			return
		}
	}

	// NIP-29 requires identities to start with the 64-char hex pubkey,
	// followed by a random suffix so the same user can join multiple times.
	suffix := make([]byte, 4)
	if _, err := randRead(suffix); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	identity := pubkey + "-" + hex.EncodeToString(suffix)

	jwt, err := mintLivekitToken(identity, groupId)
	if err != nil {
		log.Error().Err(err).Msg("failed to mint livekit token")
		http.Error(w, "failed to mint token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": jwt,
		"url":   s.LivekitURL,
	})
}

// mintLivekitToken issues a 6h LiveKit JWT granting join access to `room` for
// the given identity. NIP-29 requires identities to start with the 64-char hex
// pubkey followed by a random suffix (so a user can join from multiple tabs).
func mintLivekitToken(identity, room string) (string, error) {
	token := auth.NewAccessToken(s.LivekitAPIKey, s.LivekitAPISecret).
		SetIdentity(identity).
		SetValidFor(6 * time.Hour).
		SetVideoGrant(&auth.VideoGrant{
			RoomJoin: true,
			Room:     room,
		})
	return token.ToJWT()
}

// parseDMRoomID validates a DM voice room id of the form
// "dm:<pubkeyA>:<pubkeyB>" where both are 64-char lowercase hex pubkeys sorted
// ascending. It returns the two pubkeys and whether the id is well-formed. The
// canonical (sorted) form means both peers derive the same room id, and we can
// authorize a caller simply by checking membership in this pair.
func parseDMRoomID(roomId string) (a, b string, ok bool) {
	rest, found := strings.CutPrefix(roomId, "dm:")
	if !found {
		return "", "", false
	}
	parts := strings.Split(rest, ":")
	if len(parts) != 2 {
		return "", "", false
	}
	a, b = parts[0], parts[1]
	if !isHex64(a) || !isHex64(b) {
		return "", "", false
	}
	// Must be canonical: distinct and sorted ascending.
	if a >= b {
		return "", "", false
	}
	return a, b, true
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// handleLivekitDMToken mints a LiveKit token for a 1:1 DM voice room. Unlike
// group rooms there is no NIP-29 group to check; authorization is "the
// NIP-98-authenticated caller is one of the two pubkeys encoded in the room
// id". Presence (kind 39004) reuses the same webhook-driven `rooms` registry,
// keyed by the DM room id.
func handleLivekitDMToken(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	roomId := strings.TrimPrefix(r.URL.Path, "/.well-known/nip29/livekit-dm/")
	a, b, ok := parseDMRoomID(roomId)
	if !ok {
		http.Error(w, "invalid dm room id", http.StatusBadRequest)
		return
	}

	expectedURL := s.PublicBaseURL + "/.well-known/nip29/livekit-dm/" + roomId
	pubkey, ok := verifyNip98(r, expectedURL)
	if !ok {
		http.Error(w, "invalid NIP-98 authorization", http.StatusUnauthorized)
		return
	}

	// Access control: the caller must be one of the two DM participants.
	if pubkey != a && pubkey != b {
		http.Error(w, "restricted: not a participant of this conversation", http.StatusForbidden)
		return
	}

	suffix := make([]byte, 4)
	if _, err := randRead(suffix); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	identity := pubkey + "-" + hex.EncodeToString(suffix)

	jwt, err := mintLivekitToken(identity, roomId)
	if err != nil {
		log.Error().Err(err).Msg("failed to mint dm livekit token")
		http.Error(w, "failed to mint token", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": jwt,
		"url":   s.LivekitURL,
	})
}

func handleLivekitWebhook(w http.ResponseWriter, r *http.Request) {
	event, err := webhook.ReceiveWebhookEvent(r, auth.NewSimpleKeyProvider(s.LivekitAPIKey, s.LivekitAPISecret))
	if err != nil {
		log.Warn().Err(err).Msg("invalid livekit webhook")
		http.Error(w, "invalid webhook", http.StatusUnauthorized)
		return
	}

	roomName := ""
	if event.Room != nil {
		roomName = event.Room.Name
	}
	identity := ""
	if event.Participant != nil {
		identity = event.Participant.Identity
	}

	switch event.Event {
	case "participant_joined":
		if roomName != "" && identity != "" {
			pubkey := identity
			if i := strings.IndexByte(identity, '-'); i == 64 {
				pubkey = identity[:64]
			}
			roomsMu.Lock()
			if rooms[roomName] == nil {
				rooms[roomName] = map[string]string{}
			}
			rooms[roomName][identity] = pubkey
			roomsMu.Unlock()
			broadcastParticipants(roomName)
		}
	case "participant_left":
		if roomName != "" && identity != "" {
			roomsMu.Lock()
			delete(rooms[roomName], identity)
			roomsMu.Unlock()
			broadcastParticipants(roomName)
		}
	case "room_finished":
		if roomName != "" {
			roomsMu.Lock()
			delete(rooms, roomName)
			roomsMu.Unlock()
			broadcastParticipants(roomName)
		}
	}

	w.WriteHeader(http.StatusOK)
}

// participantsEvent builds a relay-signed kind 39004 event for a group.
func participantsEvent(groupId string) *nostr.Event {
	roomsMu.RLock()
	participants := map[string]bool{}
	for _, pubkey := range rooms[groupId] {
		participants[pubkey] = true
	}
	roomsMu.RUnlock()

	tags := nostr.Tags{nostr.Tag{"d", groupId}}
	for pubkey := range participants {
		tags = append(tags, nostr.Tag{"participant", pubkey})
	}

	evt := &nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      kindGroupParticipants,
		Tags:      tags,
	}
	if err := evt.Sign(s.RelayPrivkey); err != nil {
		log.Error().Err(err).Msg("failed to sign participants event")
		return nil
	}
	return evt
}

func broadcastParticipants(groupId string) {
	if evt := participantsEvent(groupId); evt != nil {
		relay.BroadcastEvent(evt)
	}
}

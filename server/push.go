package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/dgraph-io/badger/v4"
	"github.com/fiatjaf/relay29"
	"github.com/nbd-wtf/go-nostr"
)

// Web Push notification gateway.
//
// The relay observes every event it stores (OnEventSaved). For chat (kind 9),
// reactions (kind 7), threaded replies (kind 1111) and DMs (kind 4) it looks up
// the relevant recipients, finds their registered browser push subscriptions,
// and sends a VAPID Web Push to each — so members get notified even with the
// app closed. No external push service, no FCM/APNs: the browser's own push
// endpoint (handled by our service worker) is all that's needed.
//
// HTTP surface (all under the relay's same origin, NIP-98 authed where noted):
//
//	GET    /.well-known/armada/push          → 204 capability probe
//	GET    /.well-known/armada/push/vapid    → { "vapid_public_key": "<b64url>" }
//	PUT    /.well-known/armada/push          → register/update subscription (NIP-98)
//	DELETE /.well-known/armada/push          → remove subscription (NIP-98)
//
// Subscriptions live in the relay's existing badger DB under "push:sub:" keys.

const (
	pushVapidKey   = "push:vapid" // badger key for the persisted VAPID keypair
	pushSubPrefix  = "push:sub:"  // badger key prefix: push:sub:<pubkey>:<endpoint-hash>
	pushContentCap = 140          // max chars of message body included in a notification
	pushTTLSeconds = 24 * 60 * 60 // how long a push service should retain an undelivered push
	pushSendBurst  = 50           // max concurrent push sends per fan-out
)

// vapidKeys is the persisted VAPID keypair used to authenticate pushes.
type vapidKeys struct {
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
}

// pushPrefs are per-user notification preferences (Discord-style). All default
// to enabled when a field is absent so a fresh registration is fully opted-in.
type pushPrefs struct {
	// Mentions: a message that p-tags the user. Always implied on for DMs.
	Mentions *bool `json:"mentions,omitempty"`
	// Reactions to the user's messages (kind 7 p-tagging them).
	Reactions *bool `json:"reactions,omitempty"`
	// Replies to the user (kind 1111 p-tagging them).
	Replies *bool `json:"replies,omitempty"`
	// DirectMessages (kind 4 to the user).
	DirectMessages *bool `json:"direct_messages,omitempty"`
	// AllGroupMessages: every kind-9 message in groups the user belongs to,
	// not just mentions. Off by default (Discord "All messages" vs "Mentions").
	AllGroupMessages *bool `json:"all_group_messages,omitempty"`
}

func prefEnabled(p *bool, dflt bool) bool {
	if p == nil {
		return dflt
	}
	return *p
}

// pushRecord is what we persist per (pubkey, endpoint).
type pushRecord struct {
	Pubkey       string               `json:"pubkey"`
	Subscription webpush.Subscription `json:"subscription"`
	Prefs        pushPrefs            `json:"prefs"`
	UpdatedAt    int64                `json:"updated_at"`
}

var (
	vapid     vapidKeys
	vapidOnce sync.Once

	// pushLimiter caps per-IP request rate on the registration endpoint. Each
	// PUT/DELETE verifies a secp256k1 signature (CPU-bound), so throttle abuse
	// while staying well above a normal client (a couple of calls per session).
	pushLimiter = newRateLimiter(1, 10)
)

// setupPush initializes VAPID keys, registers the HTTP endpoints, and wires the
// fan-out hook. Safe to call once at startup. Push is always available (it
// needs no external service); it simply no-ops when no one is subscribed.
func setupPush() {
	if err := loadOrCreateVapid(); err != nil {
		log.Error().Err(err).Msg("push: failed to initialize VAPID keys; web push disabled")
		return
	}

	router := relay.Router()
	router.HandleFunc("/.well-known/armada/push", pushLimiter.limit(handlePushSubscription))
	router.HandleFunc("/.well-known/armada/push/vapid", handlePushVapid)

	// Observe every saved event and fan out notifications. OnEventSaved runs
	// after the event is durably stored and broadcast to live subscribers.
	relay.OnEventSaved = append(relay.OnEventSaved, func(ctx context.Context, event *nostr.Event) {
		// Never block the write path; fan out asynchronously.
		go fanOutPush(event)
	})

	log.Info().Msg("web push notifications enabled (/.well-known/armada/push)")
}

// loadOrCreateVapid loads the persisted VAPID keypair, generating and
// persisting one on first run. An operator may pin keys via env
// (PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY); those take precedence and
// are not persisted (env is the source of truth).
func loadOrCreateVapid() error {
	var outerErr error
	vapidOnce.Do(func() {
		if s.PushVapidPublic != "" && s.PushVapidPrivate != "" {
			vapid = vapidKeys{PublicKey: s.PushVapidPublic, PrivateKey: s.PushVapidPrivate}
			return
		}

		// Try to load from badger.
		err := db.DB.View(func(txn *badger.Txn) error {
			item, err := txn.Get([]byte(pushVapidKey))
			if err != nil {
				return err
			}
			return item.Value(func(val []byte) error {
				return json.Unmarshal(val, &vapid)
			})
		})
		if err == nil && vapid.PublicKey != "" && vapid.PrivateKey != "" {
			return
		}

		// Generate a fresh keypair and persist it.
		priv, pub, genErr := webpush.GenerateVAPIDKeys()
		if genErr != nil {
			outerErr = genErr
			return
		}
		vapid = vapidKeys{PublicKey: pub, PrivateKey: priv}
		blob, _ := json.Marshal(vapid)
		if putErr := db.DB.Update(func(txn *badger.Txn) error {
			return txn.Set([]byte(pushVapidKey), blob)
		}); putErr != nil {
			log.Warn().Err(putErr).Msg("push: failed to persist VAPID keys (will regenerate on restart)")
		}
		log.Info().Msg("push: generated new VAPID keypair")
	})
	return outerErr
}

// vapidSubject is the `sub` claim in the VAPID JWT — a contact URI for the push
// operator. Push services want a way to reach the operator; we use the relay's
// public origin, falling back to a mailto with the configured contact.
func vapidSubject() string {
	if s.RelayContact != "" {
		if strings.Contains(s.RelayContact, "@") && !strings.Contains(s.RelayContact, "://") {
			return "mailto:" + s.RelayContact
		}
		return s.RelayContact
	}
	return strings.TrimRight(s.PublicBaseURL, "/")
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

func handlePushVapid(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if vapid.PublicKey == "" {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"vapid_public_key": vapid.PublicKey})
}

// pushRegisterBody is the JSON body of a PUT (register/update) request.
type pushRegisterBody struct {
	Subscription webpush.Subscription `json:"subscription"`
	Prefs        pushPrefs            `json:"prefs"`
}

func handlePushSubscription(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w, r)
	// Reflect the methods this endpoint actually supports for preflight.
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet {
		// Capability probe.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	expectedURL := s.PublicBaseURL + "/.well-known/armada/push"
	pubkey, ok := verifyNip98(r, expectedURL)
	if !ok {
		http.Error(w, "invalid NIP-98 authorization", http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if r.Method == http.MethodDelete {
		var req pushRegisterBody
		// A DELETE may either carry the specific endpoint to remove, or no body
		// to remove every subscription for this pubkey.
		_ = json.Unmarshal(body, &req)
		if req.Subscription.Endpoint != "" {
			deletePushRecord(pubkey, req.Subscription.Endpoint)
		} else {
			deleteAllPushRecords(pubkey)
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// PUT: register or update.
	var req pushRegisterBody
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.Subscription.Endpoint == "" || req.Subscription.Keys.P256dh == "" || req.Subscription.Keys.Auth == "" {
		http.Error(w, "missing push subscription", http.StatusBadRequest)
		return
	}
	// SSRF guard: a push endpoint must be an https URL on a public host. The
	// gateway will POST to it, so reject internal/loopback targets.
	if !isSafePushEndpoint(req.Subscription.Endpoint) {
		http.Error(w, "invalid push endpoint", http.StatusBadRequest)
		return
	}

	rec := pushRecord{
		Pubkey:       pubkey,
		Subscription: req.Subscription,
		Prefs:        req.Prefs,
		UpdatedAt:    time.Now().Unix(),
	}
	if err := putPushRecord(rec); err != nil {
		log.Error().Err(err).Msg("push: failed to persist subscription")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Storage ──────────────────────────────────────────────────────────────────

func pushKey(pubkey, endpoint string) []byte {
	sum := sha256.Sum256([]byte(endpoint))
	return []byte(pushSubPrefix + pubkey + ":" + hex.EncodeToString(sum[:8]))
}

func putPushRecord(rec pushRecord) error {
	blob, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return db.DB.Update(func(txn *badger.Txn) error {
		return txn.Set(pushKey(rec.Pubkey, rec.Subscription.Endpoint), blob)
	})
}

func deletePushRecord(pubkey, endpoint string) {
	_ = db.DB.Update(func(txn *badger.Txn) error {
		return txn.Delete(pushKey(pubkey, endpoint))
	})
}

func deleteAllPushRecords(pubkey string) {
	prefix := []byte(pushSubPrefix + pubkey + ":")
	_ = db.DB.Update(func(txn *badger.Txn) error {
		it := txn.NewIterator(badger.IteratorOptions{PrefetchValues: false, Prefix: prefix})
		defer it.Close()
		var keys [][]byte
		for it.Rewind(); it.ValidForPrefix(prefix); it.Next() {
			keys = append(keys, it.Item().KeyCopy(nil))
		}
		for _, k := range keys {
			if err := txn.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
}

// recordsForPubkey returns all push subscriptions registered by a pubkey.
func recordsForPubkey(pubkey string) []pushRecord {
	prefix := []byte(pushSubPrefix + pubkey + ":")
	var out []pushRecord
	_ = db.DB.View(func(txn *badger.Txn) error {
		it := txn.NewIterator(badger.IteratorOptions{PrefetchValues: true, Prefix: prefix})
		defer it.Close()
		for it.Rewind(); it.ValidForPrefix(prefix); it.Next() {
			err := it.Item().Value(func(val []byte) error {
				var rec pushRecord
				if err := json.Unmarshal(val, &rec); err != nil {
					return nil // skip corrupt entries
				}
				out = append(out, rec)
				return nil
			})
			if err != nil {
				continue
			}
		}
		return nil
	})
	return out
}

// ── Fan-out ──────────────────────────────────────────────────────────────────

// notification is the JSON payload our service worker expects.
type notification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Icon  string `json:"icon,omitempty"`
	Badge string `json:"badge,omitempty"`
	// Data drives the click target and de-dupe tag in the service worker.
	Data notificationData `json:"data"`
}

type notificationData struct {
	// URL the client should navigate to on click (relative path).
	URL string `json:"url"`
	// Tag collapses repeated notifications for the same conversation.
	Tag string `json:"tag"`
}

// fanOutPush resolves recipients for an event and sends each their push.
// Runs in its own goroutine; must never panic the relay.
func fanOutPush(event *nostr.Event) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Error().Interface("recover", rec).Msg("push: fan-out panicked")
		}
	}()

	if vapid.PublicKey == "" {
		return
	}

	// recipient pubkey → notification to send. A map de-dupes a pubkey that
	// would match on multiple grounds (e.g. mentioned AND a group member).
	targets := resolvePushTargets(event)
	if len(targets) == 0 {
		return
	}

	sem := make(chan struct{}, pushSendBurst)
	var wg sync.WaitGroup
	for pubkey, note := range targets {
		records := recordsForPubkey(pubkey)
		for _, rec := range records {
			if !wantsNotification(rec.Prefs, event, pubkey) {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(rec pushRecord, note notification) {
				defer wg.Done()
				defer func() { <-sem }()
				sendPush(rec, note)
			}(rec, note)
		}
	}
	wg.Wait()
}

// resolvePushTargets maps each recipient pubkey to the notification they should
// receive for this event. The event author is always excluded.
func resolvePushTargets(event *nostr.Event) map[string]notification {
	targets := map[string]notification{}

	switch event.Kind {
	case 9: // group chat message
		groupId := tagValue(event, "h")
		if groupId == "" {
			return nil
		}
		group, _ := state.Groups.Load(groupId)
		if group == nil {
			return nil
		}
		title := groupTitle(group, groupId)
		body := truncate(event.Content, pushContentCap)
		clickURL := groupURL(groupId)

		// p-tagged members are mentions; all other members get the message only
		// if they've opted into "all group messages" (checked per-subscription
		// later via wantsNotification, which needs to know mention vs. not — so
		// we tag the notification accordingly in the body/title).
		mentioned := pSet(event)
		for member := range group.Members {
			if member == event.PubKey {
				continue
			}
			note := notification{
				Title: title,
				Body:  body,
				Icon:  group.Picture,
				Data:  notificationData{URL: clickURL, Tag: "group:" + groupId},
			}
			if mentioned[member] {
				note.Title = title + " — mentioned you"
			}
			targets[member] = note
		}

	case 7: // reaction
		groupId := tagValue(event, "h")
		title := s.RelayName
		if groupId != "" {
			if group, _ := state.Groups.Load(groupId); group != nil {
				title = groupTitle(group, groupId)
			}
		}
		emoji := strings.TrimSpace(event.Content)
		if emoji == "" || emoji == "+" {
			emoji = "❤️"
		}
		for recipient := range pSet(event) {
			if recipient == event.PubKey {
				continue
			}
			targets[recipient] = notification{
				Title: title,
				Body:  "Someone reacted " + emoji + " to your message",
				Data:  notificationData{URL: groupURL(groupId), Tag: "reaction:" + groupId},
			}
		}

	case 1111: // threaded reply (NIP-22 comment)
		groupId := tagValue(event, "h")
		title := s.RelayName
		if groupId != "" {
			if group, _ := state.Groups.Load(groupId); group != nil {
				title = groupTitle(group, groupId)
			}
		}
		body := truncate(event.Content, pushContentCap)
		for recipient := range pSet(event) {
			if recipient == event.PubKey {
				continue
			}
			targets[recipient] = notification{
				Title: title + " — replied to you",
				Body:  body,
				Data:  notificationData{URL: groupURL(groupId), Tag: "reply:" + groupId},
			}
		}

	case 4: // NIP-04 direct message (content is encrypted; body is generic)
		for recipient := range pSet(event) {
			if recipient == event.PubKey {
				continue
			}
			targets[recipient] = notification{
				Title: "New message",
				Body:  "You received a direct message",
				Data:  notificationData{URL: "/dms/" + event.PubKey, Tag: "dm:" + event.PubKey},
			}
		}
	}

	return targets
}

// wantsNotification applies the recipient's preferences to decide whether this
// event should be pushed to them.
func wantsNotification(prefs pushPrefs, event *nostr.Event, recipient string) bool {
	mentioned := pSet(event)[recipient]
	switch event.Kind {
	case 9:
		if mentioned {
			return prefEnabled(prefs.Mentions, true)
		}
		return prefEnabled(prefs.AllGroupMessages, false)
	case 7:
		return prefEnabled(prefs.Reactions, true)
	case 1111:
		return prefEnabled(prefs.Replies, true)
	case 4:
		return prefEnabled(prefs.DirectMessages, true)
	}
	return false
}

// sendPush delivers one Web Push, pruning the subscription if the endpoint is
// gone (410/404).
func sendPush(rec pushRecord, note notification) {
	if note.Icon == "" {
		note.Icon = "/favicon.png"
	}
	if note.Badge == "" {
		note.Badge = "/favicon.png"
	}
	payload, err := json.Marshal(note)
	if err != nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := webpush.SendNotificationWithContext(ctx, payload, &rec.Subscription, &webpush.Options{
		Subscriber:      vapidSubject(),
		VAPIDPublicKey:  vapid.PublicKey,
		VAPIDPrivateKey: vapid.PrivateKey,
		TTL:             pushTTLSeconds,
		Urgency:         webpush.UrgencyHigh,
	})
	if err != nil {
		log.Debug().Err(err).Msg("push: send failed")
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

	// 410 Gone / 404 Not Found ⇒ the subscription is dead; prune it.
	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		deletePushRecord(rec.Pubkey, rec.Subscription.Endpoint)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func tagValue(event *nostr.Event, name string) string {
	for _, t := range event.Tags {
		if len(t) >= 2 && t[0] == name {
			return t[1]
		}
	}
	return ""
}

// pSet returns the set of p-tagged pubkeys on an event.
func pSet(event *nostr.Event) map[string]bool {
	out := map[string]bool{}
	for _, t := range event.Tags {
		if len(t) >= 2 && t[0] == "p" && isHex64(t[1]) {
			out[t[1]] = true
		}
	}
	return out
}

func groupURL(groupId string) string {
	if groupId == "" {
		return "/"
	}
	return "/s/" + routeParamForRelay() + "/" + urlPathEscape(groupId)
}

// routeParamForRelay mirrors the client's relayToRouteParam(): strip the
// scheme (wss:// → bare host, ws:// → "ws:host"), then percent-encode. This
// builds the `/s/:server` path segment the SPA router expects.
func routeParamForRelay() string {
	ws := publicRelayWSURL()
	var bare string
	switch {
	case strings.HasPrefix(ws, "wss://"):
		bare = strings.TrimPrefix(ws, "wss://")
	case strings.HasPrefix(ws, "ws://"):
		bare = "ws:" + strings.TrimPrefix(ws, "ws://")
	default:
		bare = ws
	}
	return url.QueryEscape(bare)
}

// publicRelayWSURL is the relay's public WebSocket URL from a browser's
// perspective, derived from PUBLIC_BASE_URL (http→ws, https→wss) with the
// trailing slash stripped. This is the URL the client uses as the group's host
// relay, so the route param must match.
func publicRelayWSURL() string {
	base := strings.TrimRight(s.PublicBaseURL, "/")
	switch {
	case strings.HasPrefix(base, "https://"):
		return "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		return "ws://" + strings.TrimPrefix(base, "http://")
	}
	return base
}

// urlPathEscape percent-encodes a value for use as a single path segment,
// matching the client's encodeURIComponent (which the router decodes).
func urlPathEscape(v string) string {
	// url.QueryEscape encodes spaces as '+', which is wrong for a path; use
	// PathEscape and additionally encode the few chars PathEscape leaves.
	return url.PathEscape(v)
}

func groupTitle(group *relay29.Group, fallback string) string {
	if group == nil || group.Name == "" {
		return fallback
	}
	return group.Name
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	// Trim on a rune boundary.
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n])) + "…"
}

// isSafePushEndpoint rejects non-https endpoints and obvious internal targets.
// Push services are public https hosts (fcm.googleapis.com, *.notify.windows.com,
// updates.push.services.mozilla.com, web.push.apple.com, …).
func isSafePushEndpoint(endpoint string) bool {
	if !strings.HasPrefix(strings.ToLower(endpoint), "https://") {
		return false
	}
	lower := strings.ToLower(endpoint)
	for _, bad := range []string{
		"localhost", "127.0.0.1", "0.0.0.0", "::1",
		"169.254.169.254", "metadata.google.internal",
		"//10.", "//192.168.", "//172.16.", "//172.17.", "//172.18.",
		"//172.19.", "//172.2", "//172.30.", "//172.31.",
	} {
		if strings.Contains(lower, bad) {
			return false
		}
	}
	return true
}

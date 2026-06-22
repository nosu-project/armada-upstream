package main

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/fiatjaf/eventstore/badger"
	"github.com/fiatjaf/khatru"
	"github.com/fiatjaf/khatru/policies"
	"github.com/fiatjaf/relay29"
	"github.com/fiatjaf/relay29/khatru29"
	"github.com/kelseyhightower/envconfig"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip29"
	"github.com/rs/zerolog"
)

// Settings are provided through environment variables (see ../infra/.env.example).
type Settings struct {
	Port             string `envconfig:"PORT" default:"5577"`
	Domain           string `envconfig:"DOMAIN" default:"localhost:5577"`
	PublicBaseURL    string `envconfig:"PUBLIC_BASE_URL" default:"http://localhost:5577"`
	RelayName        string `envconfig:"RELAY_NAME" default:"Armada Relay"`
	RelayPrivkey     string `envconfig:"RELAY_PRIVKEY" required:"true"`
	RelayDescription string `envconfig:"RELAY_DESCRIPTION" default:"Internal NIP-29 group relay"`
	RelayContact     string `envconfig:"RELAY_CONTACT"`
	RelayIcon        string `envconfig:"RELAY_ICON"`
	DatabasePath     string `envconfig:"DATABASE_PATH" default:"./data/db"`

	// Admin-managed channels: a default NIP-29 group is provisioned on
	// startup; admins may create more at runtime. See group.go.
	GroupID     string `envconfig:"GROUP_ID" default:"armada"`
	GroupName   string `envconfig:"GROUP_NAME" default:"general"`
	AdminPubkey string `envconfig:"ADMIN_PUBKEY" required:"true"` // comma-separated npub/hex

	// LiveKit (optional). When unset the relay reports no AV support.
	LivekitURL       string `envconfig:"LIVEKIT_URL"` // e.g. ws://localhost:7880
	LivekitAPIKey    string `envconfig:"LIVEKIT_API_KEY"`
	LivekitAPISecret string `envconfig:"LIVEKIT_API_SECRET"`

	// Web Push VAPID keys (optional). When unset the relay auto-generates a
	// keypair on first run and persists it in the database. Pin these in env to
	// keep the public key stable across database wipes (rotating the public key
	// invalidates every browser's existing push subscription).
	PushVapidPublic  string `envconfig:"PUSH_VAPID_PUBLIC_KEY"`
	PushVapidPrivate string `envconfig:"PUSH_VAPID_PRIVATE_KEY"`

	RelayPubkey string `envconfig:"-"`

	// AdminPubkeys is AdminPubkey parsed into validated 32-byte hex pubkeys.
	AdminPubkeys []string `envconfig:"-"`
}

var (
	s     Settings
	db    = &badger.BadgerBackend{}
	log   = zerolog.New(os.Stderr).Output(zerolog.ConsoleWriter{Out: os.Stdout}).With().Timestamp().Logger()
	relay *khatru.Relay
	state *relay29.State
)

var (
	adminRole     = &nip29.Role{Name: "admin", Description: "full group control"}
	moderatorRole = &nip29.Role{Name: "moderator", Description: "can remove users and delete messages"}
)

func main() {
	if err := envconfig.Process("", &s); err != nil {
		log.Fatal().Err(err).Msg("couldn't process envconfig")
		return
	}
	if !nostr.IsValid32ByteHex(s.RelayPrivkey) {
		log.Fatal().Msg("RELAY_PRIVKEY must be a 64-character hex secret key")
		return
	}
	s.RelayPubkey, _ = nostr.GetPublicKey(s.RelayPrivkey)

	// The LiveKit JS SDK appends its own "/rtc" signal path to the server URL
	// it's handed. If LIVEKIT_URL already ends in "/rtc" (a common reverse-proxy
	// misconfiguration), the client ends up requesting "/rtc/rtc/..." which 404s
	// and voice silently fails. Normalize it here so the bug can't recur.
	s.LivekitURL = normalizeLivekitURL(s.LivekitURL)

	admins, err := parseAdminPubkeys(s.AdminPubkey)
	if err != nil {
		log.Fatal().Err(err).Msg("invalid ADMIN_PUBKEY")
		return
	}
	s.AdminPubkeys = admins

	db.Path = s.DatabasePath
	if err := db.Init(); err != nil {
		log.Fatal().Err(err).Msg("failed to initialize database")
		return
	}
	log.Info().Str("path", db.Path).Msg("initialized database")

	relay, state = khatru29.Init(relay29.Options{
		Domain:                  s.Domain,
		DB:                      db,
		SecretKey:               s.RelayPrivkey,
		DefaultRoles:            []*nip29.Role{adminRole, moderatorRole},
		GroupCreatorDefaultRole: adminRole,
	})

	// Role-based moderation permissions, enforced by relay29 on every
	// moderation event (NIP-29 kinds 9000-9008).
	state.AllowAction = func(ctx context.Context, group nip29.Group, role *nip29.Role, action relay29.Action) bool {
		if role == adminRole {
			return true
		}
		if role == moderatorRole {
			switch action.(type) {
			case relay29.RemoveUser, relay29.DeleteEvent, relay29.PutUser:
				return true
			}
		}
		return false
	}

	relay.Info.Name = s.RelayName
	relay.Info.Description = s.RelayDescription
	relay.Info.Contact = s.RelayContact
	relay.Info.Icon = s.RelayIcon

	// Allow non-group "unmanaged" kinds (profiles, NIP-51 group lists) so an
	// internal deployment works with this relay alone. See unmanaged.go.
	setupUnmanagedKinds()

	// Invite-code support (kind 9009 + honoring codes on kind 9021). See invites.go.
	setupInvites()

	// Work around relay29's inverted `closed` flag handling. See fixes.go.
	setupClosedFlagFix()

	// Admin-pinned messages (kind 39041). See pins.go.
	setupPinnedMessages()

	relay.RejectEvent = append(relay.RejectEvent,
		policies.PreventLargeTags(64),
		// Rich chat messages legitimately stack indexable tags: `h` + NIP-10
		// reply `e` tags + mention `p` tags + hashtag `t` tags + quote `q`
		// tags. 12 leaves headroom without allowing tag-spam. Kind 39041
		// (pinned messages) is exempt: it carries one `e` tag per pin.
		policies.PreventTooManyIndexableTags(12, []int{9005, 39041}, nil),
		policies.RestrictToSpecifiedKinds(true,
			// group content
			9, 10, 11, 12, 1111,
			30023, 31922, 31923, 9802,
			// NIP-25 reactions (kind 7), scoped to the group via `h`
			7,
			// NIP-88 polls (1068) + votes (1018), scoped to the group via `h`
			1068, 1018,
			// NIP-09 deletions (kind 5): authors editing/removing their own
			// messages. khatru enforces author-only deletion; carries an `h`
			// tag so it routes/scopes to the group.
			5,
			// moderation + membership
			9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009,
			9021, 9022,
			// Armada extension: admin-pinned messages (addressable on group id).
			39041,
			// unmanaged kinds (profiles, NIP-04 DMs, per-server self-labels,
			// user group lists)
			0, 4, 1985, 10009,
		),
		preventTimestampsInThePast,
		// Reject only *far*-future timestamps (the abuse case: pinning an event
		// to the top of timelines forever). A tight window punishes ordinary
		// device clock skew — phones drift, VMs suspend/resume — and bounces
		// legitimate joins/messages with "event too much in the future". 5
		// minutes absorbs real-world skew while still blocking far-future spam.
		policies.PreventTimestampsInTheFuture(5*time.Minute),
	)

	// LiveKit voice/video endpoints (NIP-29 AV spaces). See livekit.go.
	if s.LivekitURL != "" && s.LivekitAPIKey != "" && s.LivekitAPISecret != "" {
		// The API secret authorizes minting a token for ANY room, bypassing
		// every relay-side authorization check, so reject weak/guessable
		// secrets. LiveKit itself requires >= 32 bytes; mirror that here so a
		// misconfiguration fails loudly at startup instead of shipping a
		// trivially forgeable token signer.
		if len(s.LivekitAPISecret) < 32 {
			log.Fatal().Msg("LIVEKIT_API_SECRET must be at least 32 characters (generate with `openssl rand -hex 32`)")
			return
		}
		if isWeakLivekitSecret(s.LivekitAPISecret) {
			log.Fatal().Msg("LIVEKIT_API_SECRET looks like a placeholder/low-entropy value; set a random secret (`openssl rand -hex 32`)")
			return
		}
		setupLivekit()
		log.Info().Str("livekit", s.LivekitURL).Msg("livekit AV support enabled")
	} else {
		log.Warn().Msg("livekit not configured; voice chat disabled")
	}

	relay.Router().HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("armada relay: connect with a NIP-29 client"))
	})

	// Single-community model: provision the one group, seed admins, and reject
	// any attempt to create additional groups. See group.go.
	setupSingleGroup()

	// Web Push notifications for messages/mentions/DMs/reactions. See push.go.
	setupPush()

	log.Info().Str("relay-pubkey", s.RelayPubkey).Msg("running on http://0.0.0.0:" + s.Port)
	if err := http.ListenAndServe(":"+s.Port, relay); err != nil {
		log.Fatal().Err(err).Msg("failed to serve")
	}
}

// normalizeLivekitURL strips a trailing "/rtc" (and any trailing slash) from the
// LiveKit server URL handed to clients. The LiveKit client SDK always appends
// its own "/rtc" signal path, so a URL ending in "/rtc" produces a doubled
// "/rtc/rtc/..." request that the server returns 404 for, breaking voice.
func normalizeLivekitURL(u string) string {
	u = strings.TrimRight(u, "/")
	if strings.HasSuffix(u, "/rtc") {
		u = strings.TrimSuffix(u, "/rtc")
		u = strings.TrimRight(u, "/")
	}
	return u
}

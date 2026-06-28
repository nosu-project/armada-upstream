package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/nbd-wtf/go-nostr"
)

// Invite-code support.
//
// relay29 v0.5.1 has no kind 9009 (create-invite) action and ignores join
// requests to closed groups entirely. We implement NIP-29 invites here:
//
//   - admins/moderators publish kind 9009 with a `code` tag;
//   - kind 9021 join requests carrying a valid `code` tag are admitted even
//     when the group is closed.
//
// Invite events are deliberately NOT stored in the event database: relay29's
// startup replay (loadGroupsFromDB) panics on moderation kinds it doesn't
// know, and codes are secrets that shouldn't be queryable anyway. They are
// persisted to a JSON file next to the database instead.
var (
	inviteMu    sync.RWMutex
	inviteCodes = map[string]map[string]bool{} // groupId -> code -> true
)

func invitesPath() string {
	return filepath.Join(filepath.Dir(s.DatabasePath), "invites.json")
}

func persistInvites() {
	inviteMu.RLock()
	raw, err := json.MarshalIndent(inviteCodes, "", "  ")
	inviteMu.RUnlock()
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal invite codes")
		return
	}
	if err := os.WriteFile(invitesPath(), raw, 0o600); err != nil {
		log.Error().Err(err).Msg("failed to persist invite codes")
	}
}

func loadInvites() {
	raw, err := os.ReadFile(invitesPath())
	if err != nil {
		if !os.IsNotExist(err) {
			log.Error().Err(err).Msg("failed to read invite codes")
		}
		return
	}
	inviteMu.Lock()
	defer inviteMu.Unlock()
	if err := json.Unmarshal(raw, &inviteCodes); err != nil {
		log.Error().Err(err).Msg("failed to parse invite codes")
	}
}

func rememberInvite(groupId, code string) {
	inviteMu.Lock()
	defer inviteMu.Unlock()
	codes, ok := inviteCodes[groupId]
	if !ok {
		codes = map[string]bool{}
		inviteCodes[groupId] = codes
	}
	codes[code] = true
}

func isValidInvite(groupId, code string) bool {
	inviteMu.RLock()
	defer inviteMu.RUnlock()
	return code != "" && inviteCodes[groupId][code]
}

func setupInvites() {
	// relay29 rejects kind 9009 as an "invalid moderation action"; bypass its
	// policies for that kind and apply our own guard instead.
	for i, reject := range relay.RejectEvent {
		orig := reject
		relay.RejectEvent[i] = func(ctx context.Context, event *nostr.Event) (bool, string) {
			if event.Kind == nostr.KindSimpleGroupCreateInvite {
				return false, ""
			}
			return orig(ctx, event)
		}
	}

	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		if event.Kind != nostr.KindSimpleGroupCreateInvite {
			return false, ""
		}
		gtag := event.Tags.GetFirst([]string{"h", ""})
		if gtag == nil {
			return true, "missing group (`h`) tag"
		}
		group, _ := state.Groups.Load((*gtag)[1])
		if group == nil {
			return true, "group '" + (*gtag)[1] + "' doesn't exist"
		}
		code := event.Tags.GetFirst([]string{"code", ""})
		if code == nil || (*code)[1] == "" {
			return true, "missing invite `code` tag"
		}
		if event.PubKey == s.RelayPubkey {
			return false, ""
		}
		// only members holding a privileged role may mint invites
		roles := group.Members[event.PubKey]
		for _, role := range roles {
			if role == adminRole || role == moderatorRole {
				return false, ""
			}
		}
		return true, "insufficient permissions to create invites"
	})

	// Don't store kind 9009 in the event database (see comment above); the
	// OnEventSaved hook below persists codes to the invite file instead.
	for i, store := range relay.StoreEvent {
		orig := store
		relay.StoreEvent[i] = func(ctx context.Context, event *nostr.Event) error {
			if event.Kind == nostr.KindSimpleGroupCreateInvite {
				return nil
			}
			return orig(ctx, event)
		}
	}

	// Track minted codes.
	relay.OnEventSaved = append(relay.OnEventSaved, func(ctx context.Context, event *nostr.Event) {
		if event.Kind != nostr.KindSimpleGroupCreateInvite {
			return
		}
		gtag := event.Tags.GetFirst([]string{"h", ""})
		code := event.Tags.GetFirst([]string{"code", ""})
		if gtag != nil && code != nil {
			rememberInvite((*gtag)[1], (*code)[1])
			persistInvites()
			log.Info().Str("group", (*gtag)[1]).Msg("invite code created")
		}
	})

	// Replace relay29's join-request reaction with one that honors invite
	// codes for closed groups. NOTE: this index mirrors the OnEventSaved
	// order established by khatru29.Init (pinned at relay29 v0.5.1):
	// [ApplyModerationAction, ReactToJoinRequest, ReactToLeaveRequest, AddToPreviousChecking].
	if len(relay.OnEventSaved) > 1 {
		relay.OnEventSaved[1] = reactToJoinRequest // was state.ReactToJoinRequest
	}

	// Load previously minted invite codes.
	loadInvites()
	inviteMu.RLock()
	count := len(inviteCodes)
	inviteMu.RUnlock()
	log.Info().Int("groups", count).Msg("loaded invite codes")
}

// reactToJoinRequest admits users to open groups automatically (unless they
// were previously removed) and to closed groups when they present a valid
// invite code.
func reactToJoinRequest(ctx context.Context, event *nostr.Event) {
	if event.Kind != nostr.KindSimpleGroupJoinRequest {
		return
	}

	gtag := event.Tags.GetFirst([]string{"h", ""})
	if gtag == nil {
		return
	}
	group, _ := state.Groups.Load((*gtag)[1])
	if group == nil {
		return
	}

	if group.Closed {
		code := event.Tags.GetFirst([]string{"code", ""})
		if code == nil || !isValidInvite(group.Address.ID, (*code)[1]) {
			log.Info().Str("group", group.Address.ID).Str("pubkey", event.PubKey).
				Msg("join request to closed group without valid invite; ignoring")
			return
		}
	} else {
		// don't readmit users that were removed
		ch, err := db.QueryEvents(ctx, nostr.Filter{
			Kinds: []int{nostr.KindSimpleGroupRemoveUser},
			Tags:  nostr.TagMap{"p": []string{event.PubKey}, "h": []string{group.Address.ID}},
		})
		if err != nil {
			log.Error().Err(err).Msg("failed to check for previous removal")
			return
		}
		if nil != <-ch {
			log.Info().Str("pubkey", event.PubKey).Msg("denying access to previously removed user")
			return
		}
	}

	addUser := &nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      nostr.KindSimpleGroupPutUser,
		Tags: nostr.Tags{
			nostr.Tag{"h", group.Address.ID},
			nostr.Tag{"p", event.PubKey},
		},
	}
	if err := addUser.Sign(s.RelayPrivkey); err != nil {
		log.Error().Err(err).Msg("failed to sign put-user event")
		return
	}
	if _, err := relay.AddEvent(ctx, addUser); err != nil {
		log.Error().Err(err).Msg("failed to admit user")
		return
	}
	log.Info().Str("group", group.Address.ID).Str("pubkey", event.PubKey).Msg("admitted user")
}

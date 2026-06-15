package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/fiatjaf/relay29"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// Admin-managed multi-channel model.
//
// This relay provisions a default NIP-29 group (channel) on startup, identified
// by GROUP_ID, and seeds the admins listed in ADMIN_PUBKEY into it. Additional
// channels (kind 9007 create-group) may be created at runtime, but ONLY by a
// configured admin pubkey; create-group events from anyone else are rejected.
//
// Admin seeding is ADD-ONLY: on every boot we ensure each configured pubkey
// holds the admin role, but we never demote anyone. Admins added later at
// runtime (via kind 9000) are left untouched, and removing a pubkey from
// ADMIN_PUBKEY does NOT strip its role — do that in-app.

// parseAdminPubkeys parses the comma-separated ADMIN_PUBKEY value into a
// deduplicated list of validated 32-byte hex pubkeys. Entries may be npub or
// hex.
func parseAdminPubkeys(raw string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, 4)
	for _, part := range strings.Split(raw, ",") {
		entry := strings.TrimSpace(part)
		if entry == "" {
			continue
		}

		var pubkey string
		if strings.HasPrefix(entry, "npub1") {
			prefix, value, err := nip19.Decode(entry)
			if err != nil || prefix != "npub" {
				return nil, fmt.Errorf("invalid npub %q: %w", entry, err)
			}
			pubkey = value.(string)
		} else {
			pubkey = strings.ToLower(entry)
		}

		if !nostr.IsValid32ByteHex(pubkey) {
			return nil, fmt.Errorf("%q is not a valid npub or 64-char hex pubkey", entry)
		}
		if !seen[pubkey] {
			seen[pubkey] = true
			out = append(out, pubkey)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("must list at least one admin pubkey")
	}
	return out, nil
}

// isAdmin reports whether pubkey currently holds the admin role in the group.
func isAdmin(group *relay29.Group, pubkey string) bool {
	for _, role := range group.Members[pubkey] {
		if role == adminRole {
			return true
		}
	}
	return false
}

// canModerate reports whether pubkey holds a role permitted to moderate the
// group (admin or moderator). Mirrors the client's moderation gate.
func canModerate(group *relay29.Group, pubkey string) bool {
	for _, role := range group.Members[pubkey] {
		if role == adminRole || role == moderatorRole {
			return true
		}
	}
	return false
}

// setupSingleGroup provisions the default group on startup, seeds its admins
// (add-only), and restricts creation of additional groups to configured admins.
func setupSingleGroup() {
	ctx := context.Background()

	// Restrict create-group to configured admins. Internal provisioning
	// (state.CreateGroup) sets the internal-call context key and is allowed;
	// runtime kind 9007 events are only accepted from an ADMIN_PUBKEY.
	adminSet := make(map[string]bool, len(s.AdminPubkeys))
	for _, pubkey := range s.AdminPubkeys {
		adminSet[pubkey] = true
	}
	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		if event.Kind != nostr.KindSimpleGroupCreateGroup {
			return false, ""
		}
		if relay29.IsInternalCall(ctx) {
			return false, ""
		}
		if adminSet[event.PubKey] {
			return false, ""
		}
		return true, "blocked: only relay admins may create channels"
	})

	// Provision the group if it doesn't already exist. The first admin is the
	// creator (relay29 assigns them the group-creator default role, admin).
	group, _ := state.Groups.Load(s.GroupID)
	if group == nil {
		name := s.GroupName
		if err := state.CreateGroup(ctx, s.GroupID, s.AdminPubkeys[0], relay29.EditMetadata{
			NameValue: &name,
		}); err != nil {
			log.Fatal().Err(err).Str("group", s.GroupID).Msg("failed to provision group")
			return
		}
		group, _ = state.Groups.Load(s.GroupID)
		log.Info().Str("group", s.GroupID).Str("name", name).
			Str("creator", s.AdminPubkeys[0]).Msg("provisioned single group")
	}

	// Add-only admin seeding: ensure each configured pubkey holds the admin
	// role, without demoting anyone.
	for _, pubkey := range s.AdminPubkeys {
		if group != nil && isAdmin(group, pubkey) {
			continue
		}
		if err := state.PutUser(ctx, s.GroupID, pubkey, adminRole.Name); err != nil {
			log.Error().Err(err).Str("pubkey", pubkey).Msg("failed to seed admin")
			continue
		}
		log.Info().Str("group", s.GroupID).Str("pubkey", pubkey).Msg("seeded admin")
	}
}

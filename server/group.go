package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/fiatjaf/relay29"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip19"
)

// Single-community model.
//
// This relay hosts exactly ONE NIP-29 group, identified by GROUP_ID. It is
// provisioned automatically on startup (no in-app "create group" flow) and the
// admins listed in ADMIN_PUBKEY are seeded into it. Any attempt by a user to
// create another group (kind 9007) is rejected.
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

// setupSingleGroup provisions the one group on startup, seeds its admins
// (add-only), and rejects creation of any other group.
func setupSingleGroup() {
	ctx := context.Background()

	// Reject any user-published create-group event. Internal provisioning
	// (state.CreateGroup) sets the internal-call context key and is allowed.
	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		if event.Kind != nostr.KindSimpleGroupCreateGroup {
			return false, ""
		}
		if relay29.IsInternalCall(ctx) {
			return false, ""
		}
		return true, "blocked: this relay hosts a single group; group creation is disabled"
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

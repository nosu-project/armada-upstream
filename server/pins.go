package main

import (
	"context"

	"github.com/nbd-wtf/go-nostr"
)

// KindGroupPins is the Armada extension kind carrying a group's set of pinned
// messages: an addressable event (`d` = group id) with one `e` tag per pinned
// message. It is NOT part of NIP-29 proper. Only group admins/moderators may
// write it; the newest such event is authoritative for the group.
const KindGroupPins = 39041

// setupPinnedMessages restricts writes of the pinned-messages event (kind
// 39041) to a group's admins/moderators. Membership alone is already enforced
// by relay29's RestrictWritesBasedOnGroupRules; this adds the role gate so a
// regular member can't pin or unpin.
func setupPinnedMessages() {
	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		if event.Kind != KindGroupPins {
			return false, ""
		}

		// The relay's own key may always write (e.g. internal automation).
		if event.PubKey == s.RelayPubkey {
			return false, ""
		}

		gtag := event.Tags.GetFirst([]string{"h", ""})
		if gtag == nil {
			return true, "missing group (`h`) tag"
		}
		groupId := (*gtag)[1]

		// The `d` tag must match the group so the addressable event is keyed
		// per-group and can't masquerade under another group's coordinate.
		dtag := event.Tags.GetFirst([]string{"d", ""})
		if dtag == nil || (*dtag)[1] != groupId {
			return true, "pinned-messages `d` tag must equal the group id"
		}

		group, _ := state.Groups.Load(groupId)
		if group == nil {
			return true, "group '" + groupId + "' doesn't exist"
		}

		// Note: Members is read without the (unexported) group lock, matching
		// the rest of this package's role checks (isAdmin). Membership churn is
		// rare relative to pin writes.
		if !canModerate(group, event.PubKey) {
			return true, "blocked: only admins or moderators may pin messages"
		}

		return false, ""
	})
}

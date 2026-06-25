package main

import (
	"context"

	"github.com/nbd-wtf/go-nostr"
)

// NIP-52 calendar event kinds, scoped to a NIP-29 group via an `h` tag.
//
//   - 31922 (date-based) / 31923 (time-based) are the events themselves.
//     Creating one is a curation action, so writes are restricted to a group's
//     admins/moderators — mirroring the pinned-messages gate.
//   - 31925 (RSVP) is a member action: any group member may RSVP. relay29's
//     RestrictWritesBasedOnGroupRules already requires membership, so the gate
//     here only validates that the event is well-formed and group-scoped.
//
// All three are addressable (30000-39999), keyed by their `d` tag. The `h` tag
// is what lets relay29 route the write to the group DB and serve it back on a
// group-scoped query. Not part of NIP-29 proper.
const (
	KindCalendarDate = 31922
	KindCalendarTime = 31923
	KindCalendarRSVP = 31925
)

// setupCalendarEvents restricts who may write NIP-52 calendar events in a group
// and validates their group scoping. Calendar events (31922/31923) are
// admin/moderator-only (like pins); RSVPs (31925) are open to any member.
func setupCalendarEvents() {
	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		isEvent := event.Kind == KindCalendarDate || event.Kind == KindCalendarTime
		isRSVP := event.Kind == KindCalendarRSVP
		if !isEvent && !isRSVP {
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

		// Addressable events must carry a `d` tag.
		if dtag := event.Tags.GetFirst([]string{"d", ""}); dtag == nil || (*dtag)[1] == "" {
			return true, "calendar events must carry a `d` tag"
		}

		group, _ := state.Groups.Load(groupId)
		if group == nil {
			return true, "group '" + groupId + "' doesn't exist"
		}

		// RSVPs are a member action; relay29 already enforces membership for
		// writes, so nothing more to gate here.
		if isRSVP {
			return false, ""
		}

		// Calendar events themselves are curation: admins/moderators only.
		if !canModerate(group, event.PubKey) {
			return true, "blocked: only admins or moderators may create calendar events"
		}

		return false, ""
	})
}

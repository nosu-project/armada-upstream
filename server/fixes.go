package main

import (
	"context"

	"github.com/nbd-wtf/go-nostr"
)

// preventTimestampsInThePast rejects events whose created_at is more than a
// minute in the past — EXCEPT editable content kinds (chat messages, polls),
// which clients edit by deleting the original (NIP-09) and republishing a new
// event carrying the ORIGINAL created_at, so the edit keeps its place in the
// timeline. Without this exemption that republish would be rejected as "too
// old". Self-authorship of the delete is still enforced by khatru's NIP-09
// handling, and future timestamps are still rejected separately.
func preventTimestampsInThePast(ctx context.Context, event *nostr.Event) (reject bool, msg string) {
	switch event.Kind {
	case 9, 1068: // group chat, polls — may be republished as an edit
		return false, ""
	}
	const tooOld = 60 // seconds
	if nostr.Now()-event.CreatedAt > tooOld {
		return true, "event too old"
	}
	return false, ""
}

// relay29 v0.5.1 has an inverted boolean in EditMetadata.Apply:
//
//	if a.ClosedValue != nil {
//	    group.Closed = !*a.ClosedValue   // <- bug: negates the value
//	}
//
// so a kind 9002 with a `closed` tag OPENS the group and vice versa. The bug
// affects both live processing (ApplyModerationAction) and the startup replay
// (loadGroupsFromDB). We correct the in-memory state in both places.
func setupClosedFlagFix() {
	// Live: runs after relay29's ApplyModerationAction (OnEventSaved order).
	relay.OnEventSaved = append(relay.OnEventSaved, func(ctx context.Context, event *nostr.Event) {
		if event.Kind != nostr.KindSimpleGroupEditMetadata {
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
		if event.Tags.GetFirst([]string{"closed"}) != nil {
			group.Closed = true
		} else if event.Tags.GetFirst([]string{"open"}) != nil {
			group.Closed = false
		}
	})

	// Startup: recompute Closed from the latest 9002 per group.
	ch, err := db.QueryEvents(context.Background(), nostr.Filter{
		Kinds: []int{nostr.KindSimpleGroupEditMetadata},
	})
	if err != nil {
		log.Error().Err(err).Msg("failed to replay edit-metadata events for closed-flag fix")
		return
	}
	latest := map[string]*nostr.Event{} // groupId -> newest 9002
	for event := range ch {
		gtag := event.Tags.GetFirst([]string{"h", ""})
		if gtag == nil {
			continue
		}
		id := (*gtag)[1]
		if prev, ok := latest[id]; !ok || prev.CreatedAt < event.CreatedAt {
			latest[id] = event
		}
	}
	for id, event := range latest {
		group, _ := state.Groups.Load(id)
		if group == nil {
			continue
		}
		if event.Tags.GetFirst([]string{"closed"}) != nil {
			group.Closed = true
		} else if event.Tags.GetFirst([]string{"open"}) != nil {
			group.Closed = false
		}
	}
}

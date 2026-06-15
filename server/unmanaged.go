package main

import (
	"context"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
)

// Unmanaged kinds are normal Nostr events that have nothing to do with
// NIP-29 groups but that an internal single-relay deployment still needs:
//
//   - kind 0:     user profiles (display names and avatars in the client)
//   - kind 4:     NIP-04 encrypted direct messages (relay-scoped DMs)
//   - kind 10009: the user's NIP-51 list of joined groups
//
// relay29's policies reject everything without an `h` tag, so we wrap them
// to skip these kinds, and add our own guard requiring NIP-42 auth so only
// the key owner can publish them.
func isUnmanagedKind(kind int) bool {
	return kind == 0 || kind == 4 || kind == 10009
}

// isDMKind reports whether the kind is a relay-scoped direct message (NIP-04).
// DMs share the unmanaged-kind machinery but have stricter read rules: only a
// conversation participant may query them (enforced in the RejectFilter guard).
func isDMKind(kind int) bool {
	return kind == 4
}

func setupUnmanagedKinds() {
	// Skip the relay29/khatru reject policies registered so far for
	// unmanaged kinds; our own guard below takes over.
	for i, reject := range relay.RejectEvent {
		orig := reject
		relay.RejectEvent[i] = func(ctx context.Context, event *nostr.Event) (bool, string) {
			if isUnmanagedKind(event.Kind) {
				return false, ""
			}
			return orig(ctx, event)
		}
	}

	// Only the authenticated key owner may write their own events (profile,
	// group list, or DM — a DM is signed by its sender).
	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		if !isUnmanagedKind(event.Kind) {
			return false, ""
		}
		authed := khatru.GetAuthed(ctx)
		if authed == "" {
			return true, "auth-required: must authenticate to publish this event"
		}
		if authed != event.PubKey {
			return true, "restricted: cannot publish events for other pubkeys"
		}
		return false, ""
	})

	// relay29's OnEventSaved handlers assume every saved event has an `h`
	// tag (AddToPreviousChecking dereferences it); skip them for unmanaged kinds.
	for i, handler := range relay.OnEventSaved {
		orig := handler
		relay.OnEventSaved[i] = func(ctx context.Context, event *nostr.Event) {
			if isUnmanagedKind(event.Kind) {
				return
			}
			orig(ctx, event)
		}
	}

	// Same treatment for filters: relay29 requires h/d tags on every REQ,
	// which would break profile lookups. Unmanaged-kind queries must specify
	// authors (so they can't be used to scrape the whole database).
	for i, reject := range relay.RejectFilter {
		orig := reject
		relay.RejectFilter[i] = func(ctx context.Context, filter nostr.Filter) (bool, string) {
			if filterIsUnmanaged(filter) {
				return false, ""
			}
			return orig(ctx, filter)
		}
	}
	relay.RejectFilter = append(relay.RejectFilter, func(ctx context.Context, filter nostr.Filter) (bool, string) {
		if !filterIsUnmanaged(filter) {
			return false, ""
		}
		// DMs (kind 4) are private: only a conversation participant may read
		// them. Require NIP-42 auth and that the authed pubkey is either the
		// sender (authors) or a recipient (`#p`) the query is scoped to. This
		// both prevents scraping and stops anyone reading others' DMs.
		if filterIsDM(filter) {
			authed := khatru.GetAuthed(ctx)
			if authed == "" {
				return true, "auth-required: must authenticate to read direct messages"
			}
			inAuthors := contains(filter.Authors, authed)
			inRecipients := contains(filter.Tags["p"], authed)
			if !inAuthors && !inRecipients {
				return true, "restricted: can only read direct messages you sent or received"
			}
			return false, ""
		}
		if len(filter.Authors) == 0 {
			return true, "unmanaged-kind queries must specify authors"
		}
		return false, ""
	})

	// Serve unmanaged-kind queries straight from the database. (relay29's
	// NormalEventQuery ignores filters without h/e/a/ids tags.)
	relay.QueryEvents = append(relay.QueryEvents, func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
		if !filterIsUnmanaged(filter) {
			ch := make(chan *nostr.Event)
			close(ch)
			return ch, nil
		}
		return db.QueryEvents(ctx, filter)
	})
}

func filterIsUnmanaged(filter nostr.Filter) bool {
	if len(filter.Kinds) == 0 {
		return false
	}
	for _, kind := range filter.Kinds {
		if !isUnmanagedKind(kind) {
			return false
		}
	}
	return true
}

// filterIsDM reports whether an (already unmanaged) filter touches DMs. Any
// filter that includes kind 4 is held to the stricter participant-only rule.
func filterIsDM(filter nostr.Filter) bool {
	for _, kind := range filter.Kinds {
		if isDMKind(kind) {
			return true
		}
	}
	return false
}

func contains(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

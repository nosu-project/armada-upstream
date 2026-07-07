package main

import (
	"context"

	"github.com/nbd-wtf/go-nostr"
)

// NIP-46 remote-signer support (kind 24133).
//
// The client offers this relay (plus the configured app relays) as the
// rendezvous point for NIP-46 remote signers like Amber — both for the
// `nostrconnect://` login handshake and for every subsequent sign/encrypt
// round-trip (see client useLoginActions.getRelayUrls). Out of the box,
// relay29's policies reject that traffic in both directions: kind 24133
// events carry no group `h` tag ("missing group (`h`) tag") and the signer's
// subscription filter `{"kinds":[24133],"#p":[...]}` has no h/e/a/ids
// ("invalid query"). A signer pairing pointed only at this relay therefore
// fails silently.
//
// Kind 24133 is ephemeral (20000-29999): khatru never stores it and never
// runs OnEventSaved for it — events are only forwarded live to matching
// subscriptions. So supporting NIP-46 needs exactly two carve-outs, mirroring
// the unmanaged-kinds treatment in unmanaged.go:
//
//   - writes: skip the relay29 group policies; require a `p` tag (every
//     NIP-46 request/response addresses its counterparty) so the relay can't
//     be used as an unaddressed broadcast channel. No NIP-42 auth: the
//     sender is an ephemeral client transport key or the signer app itself,
//     neither of which reliably AUTHs, and the payload is NIP-44 encrypted
//     end-to-end anyway.
//   - reads: skip relay29's filter policy for pure kind-24133 filters;
//     require a `#p` scope so a subscriber only sees traffic addressed to a
//     specific key rather than the whole signer firehose.
//
// The general khatru policies appended later in main() (large tags, kind
// allow-list — which permits ephemeral kinds, timestamp bounds) still apply.
func isNip46Kind(kind int) bool {
	return kind == 24133
}

func setupNip46() {
	// Skip the relay29/khatru reject policies registered so far for NIP-46
	// events; our own guard below takes over.
	for i, reject := range relay.RejectEvent {
		orig := reject
		relay.RejectEvent[i] = func(ctx context.Context, event *nostr.Event) (bool, string) {
			if isNip46Kind(event.Kind) {
				return false, ""
			}
			return orig(ctx, event)
		}
	}
	relay.RejectEvent = append(relay.RejectEvent, func(ctx context.Context, event *nostr.Event) (bool, string) {
		if !isNip46Kind(event.Kind) {
			return false, ""
		}
		if ptag := event.Tags.GetFirst([]string{"p", ""}); ptag == nil || !nostr.IsValid32ByteHex((*ptag)[1]) {
			return true, "invalid: nip-46 events must p-tag their recipient"
		}
		return false, ""
	})

	// Same for filters: a pure kind-24133 subscription is legitimate as long
	// as it is scoped to recipients via `#p`.
	for i, reject := range relay.RejectFilter {
		orig := reject
		relay.RejectFilter[i] = func(ctx context.Context, filter nostr.Filter) (bool, string) {
			if filterIsNip46(filter) {
				return false, ""
			}
			return orig(ctx, filter)
		}
	}
	relay.RejectFilter = append(relay.RejectFilter, func(ctx context.Context, filter nostr.Filter) (bool, string) {
		if !filterIsNip46(filter) {
			return false, ""
		}
		if len(filter.Tags["p"]) == 0 {
			return true, "nip-46 queries must specify recipients (`#p`)"
		}
		return false, ""
	})

	// No QueryEvents handler: kind 24133 is never stored, so REQs get an
	// immediate EOSE and then live events as they are forwarded.
}

func filterIsNip46(filter nostr.Filter) bool {
	if len(filter.Kinds) == 0 {
		return false
	}
	for _, kind := range filter.Kinds {
		if !isNip46Kind(kind) {
			return false
		}
	}
	return true
}

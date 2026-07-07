package main

import (
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// Anti-replay cache for one-shot authorization events (NIP-98 LiveKit token
// grants). Grants are short-lived
// (validated within a ±60s freshness window) and must be single-use: without
// this, anyone who observes a signed grant — a logging proxy, a shared
// network — can replay it within the window to mint their own
// LiveKit JWT. NIP-98 explicitly recommends tracking seen event ids.
//
// We remember each grant's event id until just past its freshness window and
// reject any id seen twice. Entries are pruned lazily and by a background
// sweeper so the map can't grow without bound.

// replayWindow is how long a remembered id is retained. It must be at least the
// grant freshness window (60s each side) so an id can't be evicted while the
// same grant would still pass the freshness check and be replayable.
const replayWindow = 2 * time.Minute

var (
	seenMu    sync.Mutex
	seenGrant = map[string]nostr.Timestamp{} // event id -> expiry
)

func init() {
	go func() {
		ticker := time.NewTicker(replayWindow)
		defer ticker.Stop()
		for range ticker.C {
			pruneSeenGrants()
		}
	}()
}

// rememberGrant records the grant id as used and reports whether it was already
// seen (i.e. this is a replay). The first caller for a given id gets false; any
// subsequent caller within the retention window gets true.
func rememberGrant(id string) (replayed bool) {
	now := nostr.Now()
	expiry := now + nostr.Timestamp(replayWindow/time.Second)

	seenMu.Lock()
	defer seenMu.Unlock()
	if exp, ok := seenGrant[id]; ok && exp > now {
		return true
	}
	seenGrant[id] = expiry
	return false
}

func pruneSeenGrants() {
	now := nostr.Now()
	seenMu.Lock()
	defer seenMu.Unlock()
	for id, exp := range seenGrant {
		if exp <= now {
			delete(seenGrant, id)
		}
	}
}

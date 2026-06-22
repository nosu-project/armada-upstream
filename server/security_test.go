package main

import "testing"

func TestRememberGrant(t *testing.T) {
	id := "deadbeef"
	if rememberGrant(id) {
		t.Fatal("first use of a grant id must not be flagged as replay")
	}
	if !rememberGrant(id) {
		t.Fatal("second use of the same grant id must be flagged as replay")
	}
	if rememberGrant("cafebabe") {
		t.Fatal("a distinct grant id must not be flagged as replay")
	}
}

func TestIsWeakLivekitSecret(t *testing.T) {
	weak := []string{"armada", "ARMADA", "secret", "changeme", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	for _, s := range weak {
		if !isWeakLivekitSecret(s) {
			t.Errorf("expected %q to be flagged as weak", s)
		}
	}
	strong := []string{"7f3c9a2b1e4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a"}
	for _, s := range strong {
		if isWeakLivekitSecret(s) {
			t.Errorf("expected %q to be accepted", s)
		}
	}
}

func TestPubkeyFromIdentity(t *testing.T) {
	pk := "7f3c9a2b1e4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a"
	if got := pubkeyFromIdentity(pk + "-abcd1234"); got != pk {
		t.Errorf("group/DM identity: got %q, want %q", got, pk)
	}
	// A fully-random Concord identity has no embedded valid pubkey and must be
	// returned unchanged (and later skipped by participantsEvent).
	rand := "0011223344556677"
	if got := pubkeyFromIdentity(rand); got != rand {
		t.Errorf("random identity: got %q, want %q", got, rand)
	}
	// 64-char-then-dash but not valid hex: must not be treated as a pubkey.
	notHex := "zz3c9a2b1e4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a"
	if got := pubkeyFromIdentity(notHex + "-abcd1234"); got != notHex+"-abcd1234" {
		t.Errorf("non-hex prefix must be returned unchanged, got %q", got)
	}
}

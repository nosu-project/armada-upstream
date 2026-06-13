package main

import "crypto/rand"

// randRead fills b with cryptographically secure random bytes.
func randRead(b []byte) (int, error) {
	return rand.Read(b)
}

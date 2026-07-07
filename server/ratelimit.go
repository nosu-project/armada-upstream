package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Per-IP rate limiting for the LiveKit token + webhook endpoints.
//
// Each request to a token endpoint performs a secp256k1 signature verification
// (CPU-bound) before any authorization decision, so an unauthenticated client
// can spam expensive work, and a client holding any one valid grant could spam
// the SFU with token mints. A simple per-IP token bucket caps the damage
// without affecting normal use (a client fetches at most a handful of tokens
// per call).

// rateLimiter is a fixed-rate token bucket keyed by client IP.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens added per second
	burst   float64 // max tokens
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter(ratePerSec, burst float64) *rateLimiter {
	rl := &rateLimiter{
		buckets: map[string]*bucket{},
		rate:    ratePerSec,
		burst:   burst,
	}
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			rl.prune()
		}
	}()
	return rl
}

// allow reports whether a request from key may proceed, consuming one token.
func (rl *rateLimiter) allow(key string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[key]
	if !ok {
		rl.buckets[key] = &bucket{tokens: rl.burst - 1, last: now}
		return true
	}
	elapsed := now.Sub(b.last).Seconds()
	b.last = now
	b.tokens += elapsed * rl.rate
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (rl *rateLimiter) prune() {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	for key, b := range rl.buckets {
		// Drop buckets that would have fully refilled (idle long enough).
		if now.Sub(b.last).Seconds()*rl.rate >= rl.burst {
			delete(rl.buckets, key)
		}
	}
}

// limit wraps h, rejecting requests from an IP that exceeds the bucket with 429.
// OPTIONS preflights are never rate-limited (they carry no auth and must always
// answer for CORS to work).
func (rl *rateLimiter) limit(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			h(w, r)
			return
		}
		if !rl.allow(clientIP(r)) {
			corsHeaders(w, r)
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

// clientIP extracts the caller's IP, honoring a single reverse-proxy hop. We
// trust X-Real-IP / the last X-Forwarded-For entry only because this service is
// designed to sit behind a known edge proxy (see AGENTS.md); direct exposure
// would let a client spoof these. Falls back to the socket address.
func clientIP(r *http.Request) string {
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

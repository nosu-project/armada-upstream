/**
 * CORD stream NIP-42 auth — "AUTH as the room".
 *
 * DM-protecting relays (e.g. relay.ditto.pub) treat kind 1059 as an
 * auth-protected kind: an `authors`-filtered REQ is CLOSED with
 * `auth-required` unless the connection has NIP-42-authenticated as every
 * pubkey in the filter. For NIP-59 that guards recipients' inboxes; for CORD
 * it is effectively a capability check — "prove you hold the stream key" —
 * which members trivially can: the derived group secret key signs every wrap
 * (CORD-02 A.2), so it can just as well sign a kind-22242 AUTH event.
 *
 * This module keeps a registry of stream keys per relay and answers every
 * NIP-42 challenge with one AUTH per registered key (relays accumulate
 * authed pubkeys per connection — verified against ditto-relay). Signing is
 * local Schnorr over a held secret key: no bunker round-trip, ever.
 *
 * Linkability note: a connection that AUTHs as the user (DM inbox) AND as
 * stream keys tells that relay which streams the user belongs to. That is the
 * price of admission on auth-demanding relays; the CORD-05 stock Vector
 * relays serve stream reads unauthenticated and learn nothing.
 */

import { finalizeEvent } from "nostr-tools/pure";

import { normalizeRelayUrl } from "@/lib/platform";

/** The two halves of a stream identity we need to AUTH with. */
export interface StreamAuthKey {
  /** x-only pubkey hex — the Stream address. */
  pk: string;
  /** The derived secp256k1 secret key that signs as the address. */
  sk: Uint8Array;
}

/** One relay's live NIP-42 state: the current challenge + what's been sent. */
interface RelayConn {
  challenge: string;
  send: (frame: string) => void;
  /** pks already AUTHed against the CURRENT challenge (reset on a new one). */
  authed: Set<string>;
}

/** relay url → (stream pk → sk). Registration is idempotent and append-only. */
const keysByRelay = new Map<string, Map<string, Uint8Array>>();
/** relay url → live challenge state (set by the pool's auth callback). */
const conns = new Map<string, RelayConn>();

function norm(url: string): string | undefined {
  return normalizeRelayUrl(url);
}

function sendAuth(url: string, conn: RelayConn, pk: string, sk: Uint8Array): void {
  try {
    const event = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [
          ["relay", url],
          ["challenge", conn.challenge],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    );
    conn.send(JSON.stringify(["AUTH", event]));
    conn.authed.add(pk);
  } catch {
    // A failed frame (socket flap) is retried on the next challenge.
  }
}

/**
 * Register stream keys for a set of relays. Idempotent — re-registering is
 * free. Keys registered onto a relay whose connection already presented a
 * challenge are AUTHed immediately (so a rekey probe or a newly-joined
 * community authenticates mid-connection, without waiting for a reconnect).
 */
export function registerCordStreamKeys(relays: string[], groups: StreamAuthKey[]): void {
  for (const raw of relays) {
    const url = norm(raw);
    if (!url) continue;
    let keys = keysByRelay.get(url);
    if (!keys) {
      keys = new Map();
      keysByRelay.set(url, keys);
    }
    const conn = conns.get(url);
    for (const g of groups) {
      if (!keys.has(g.pk)) keys.set(g.pk, g.sk);
      if (conn && !conn.authed.has(g.pk)) sendAuth(url, conn, g.pk, g.sk);
    }
  }
}

/**
 * Feed a relay's NIP-42 challenge to the stream-auth machinery. Called by the
 * pool's `auth` callback for EVERY challenge, before the user's own AUTH is
 * signed. A new challenge (fresh connection / relay-side reset) re-AUTHs every
 * registered key; a re-issued identical challenge only fills in gaps.
 */
export function onCordAuthChallenge(rawUrl: string, challenge: string, send: (frame: string) => void): void {
  const url = norm(rawUrl);
  if (!url) return;
  let conn = conns.get(url);
  if (!conn || conn.challenge !== challenge) {
    conn = { challenge, send, authed: new Set() };
    conns.set(url, conn);
  } else {
    conn.send = send; // keep the freshest socket handle
  }
  const keys = keysByRelay.get(url);
  if (!keys) return;
  for (const [pk, sk] of keys) {
    if (!conn.authed.has(pk)) sendAuth(url, conn, pk, sk);
  }
}

/** Test-only: drop all registered keys and connection state. */
export function resetCordStreamAuth(): void {
  keysByRelay.clear();
  conns.clear();
}

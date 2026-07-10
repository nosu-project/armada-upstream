/**
 * Concord V2 stream-key NIP-42 authentication.
 *
 * Every V2 plane is kind-1059 traffic addressed to a DERIVED per-stream pubkey
 * (control, guestbook, per-channel, dissolved, rekey) — never the user's own
 * identity. Relays that gate kind 1059 behind NIP-42 (e.g. ditto-relay's
 * default `AUTH_KINDS=4,1059`) require that EVERY `authors` entry in a
 * kind-1059 REQ be an authenticated pubkey on the connection. The user's login
 * can't satisfy that: the stream address isn't their pubkey.
 *
 * The fix: the client holds the stream SECRET keys (they live in the
 * community_root / channel keys it derives), so it can NIP-42-authenticate AS
 * each stream. This module is the registry of stream keys the client currently
 * holds; {@link NostrProvider}'s AUTH handler signs an extra kind-22242 event
 * per registered key on the same challenge, so the connection ends up
 * authenticated as the user AND every stream it will query.
 *
 * Keys register with the RELAYS their community lives on, and a challenge
 * signs only the keys scoped to that relay (a key registered without relays is
 * unscoped and signs everywhere — the safe fallback). This matters: a Schnorr
 * signature costs ~4ms (phones 5-10x slower), a multi-community registry holds
 * hundreds of keys, and every socket (re)open earns a fresh challenge —
 * unscoped, one challenge burned 1.5-2s of main-thread signing per relay (see
 * streamAuth.perf.test.ts) for keys the relay would never see queried.
 *
 * Kept out of `concord-v1` and imported by only two shared files
 * (NostrProvider for the WebView's own sockets, useNativeNotifications for
 * the Android service's bridged AUTH challenges) so the V2 tree stays
 * independently deletable.
 */

import { finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import type { GroupKey } from "@/concord-v2/lib/derive";
import { normalizeRelayUrl } from "@/lib/platform";

interface StreamKeyEntry {
  /** The stream secret key that authenticates this pubkey. */
  sk: Uint8Array;
  /**
   * Normalized relay URLs whose challenges this key signs; `undefined` means
   * unscoped — sign on EVERY relay (pre-scoping behavior, the safe fallback
   * for callers that don't know their community's relays).
   */
  relays?: Set<string>;
}

/** pubkey (x-only hex) → its secret key + relay scope. */
const registry = new Map<string, StreamKeyEntry>();

/** Listeners notified when the registry gains keys (to re-auth open sockets). */
type Listener = (added: string[]) => void;
const listeners = new Set<Listener>();

function normalizeScope(relays?: string[]): Set<string> | undefined {
  if (!relays) return undefined;
  const out = new Set<string>();
  for (const r of relays) {
    const n = normalizeRelayUrl(r);
    if (n) out.add(n);
  }
  // An empty/garbage relay list must not silently scope a key to NOWHERE —
  // fall back to unscoped so the stream can still authenticate.
  return out.size > 0 ? out : undefined;
}

/**
 * Register a batch of stream keys (idempotent), scoped to the relays their
 * community lives on. Returns the pubkeys that were NEWLY added or whose
 * relay scope WIDENED (a new relay, or scoped → unscoped), so the caller can
 * trigger a re-auth only when a challenged socket might be missing coverage.
 *
 * Scopes only ever widen: re-registering with fewer relays never narrows an
 * existing key (a second community sharing a channel key on other relays must
 * not lose its coverage).
 */
export function registerStreamKeys(keys: GroupKey[], relays?: string[]): string[] {
  const scope = normalizeScope(relays);
  const changed: string[] = [];
  for (const k of keys) {
    const existing = registry.get(k.pk);
    if (!existing) {
      registry.set(k.pk, { sk: k.sk, relays: scope ? new Set(scope) : undefined });
      changed.push(k.pk);
      continue;
    }
    if (!existing.relays) continue; // already unscoped — broadest possible
    if (!scope) {
      existing.relays = undefined; // widen to unscoped
      changed.push(k.pk);
      continue;
    }
    let widened = false;
    for (const r of scope) {
      if (!existing.relays.has(r)) {
        existing.relays.add(r);
        widened = true;
      }
    }
    if (widened) changed.push(k.pk);
  }
  if (changed.length > 0) for (const l of listeners) l(changed);
  return changed;
}

/** Whether a pubkey is a known stream address we can authenticate as. */
export function isStreamPubkey(pubkey: string): boolean {
  return registry.has(pubkey);
}

/** Every stream pubkey currently registered. */
export function streamPubkeys(): string[] {
  return [...registry.keys()];
}

/** The registered pubkeys whose scope covers `relayUrl` (unscoped keys always do). */
export function streamPubkeysForRelay(relayUrl: string): string[] {
  const normalized = normalizeRelayUrl(relayUrl);
  const out: string[] = [];
  for (const [pk, entry] of registry) {
    if (!entry.relays || (normalized !== undefined && entry.relays.has(normalized))) out.push(pk);
  }
  return out;
}

/**
 * Subscribe to registry growth. The listener fires with the newly-added (or
 * scope-widened) pubkeys whenever {@link registerStreamKeys} admits any.
 * Returns an unsubscribe.
 */
export function onStreamKeysAdded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Sign the NIP-42 AUTH events for the registered stream keys scoped to
 * `relayUrl` (or an explicit subset) against `challenge`. Signing is local
 * (raw secret keys), so this never touches the user's signer / bunker.
 * Returns the kind-22242 events to send on the connection.
 *
 * Each signature is ~4ms of main-thread EC work — for more than a handful of
 * keys, prefer {@link signStreamAuthsChunked} so the loop yields between
 * chunks instead of blocking frames.
 */
export function signStreamAuths(
  challenge: string,
  relayUrl: string,
  pubkeys?: Iterable<string>,
): NostrEvent[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const out: NostrEvent[] = [];
  for (const pk of pubkeys ?? streamPubkeysForRelay(relayUrl)) {
    const sk = registry.get(pk)?.sk;
    if (!sk) continue;
    out.push(
      finalizeEvent(
        {
          kind: 22242,
          content: "",
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          created_at: createdAt,
        },
        sk,
      ),
    );
  }
  return out;
}

/** Keys signed per event-loop turn by {@link signStreamAuthsChunked} (~4ms each). */
const SIGN_CHUNK = 16;

/**
 * Like {@link signStreamAuths}, but yields the events in chunks with an
 * event-loop turn between them, so signing dozens of keys doesn't block
 * rendering for hundreds of milliseconds. The caller sends each chunk as it
 * arrives (a NIP-42 AUTH is valid whenever it lands on the live challenge)
 * and can stop iterating if the challenge dies mid-flight (socket reopened).
 */
export async function* signStreamAuthsChunked(
  challenge: string,
  relayUrl: string,
  pubkeys?: Iterable<string>,
): AsyncGenerator<NostrEvent[]> {
  const pks = [...(pubkeys ?? streamPubkeysForRelay(relayUrl))];
  for (let i = 0; i < pks.length; i += SIGN_CHUNK) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    yield signStreamAuths(challenge, relayUrl, pks.slice(i, i + SIGN_CHUNK));
  }
}

/** Test seam: forget every registered stream key. */
export function _resetStreamAuthRegistry(): void {
  registry.clear();
}

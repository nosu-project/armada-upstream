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
 * Kept out of `concord-v1` and imported by only two shared files
 * (NostrProvider for the WebView's own sockets, useNativeNotifications for
 * the Android service's bridged AUTH challenges) so the V2 tree stays
 * independently deletable.
 */

import { finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import type { GroupKey } from "@/concord-v2/lib/derive";

/** pubkey (x-only hex) → the stream secret key that authenticates it. */
const registry = new Map<string, Uint8Array>();

/** Listeners notified when the registry gains keys (to re-auth open sockets). */
type Listener = (added: string[]) => void;
const listeners = new Set<Listener>();

/**
 * Register a batch of stream keys (idempotent). Returns the pubkeys that were
 * NEWLY added, so the caller can trigger a re-auth only when the set changed.
 */
export function registerStreamKeys(keys: GroupKey[]): string[] {
  const added: string[] = [];
  for (const k of keys) {
    if (registry.has(k.pk)) continue;
    registry.set(k.pk, k.sk);
    added.push(k.pk);
  }
  if (added.length > 0) for (const l of listeners) l(added);
  return added;
}

/** Whether a pubkey is a known stream address we can authenticate as. */
export function isStreamPubkey(pubkey: string): boolean {
  return registry.has(pubkey);
}

/** Every stream pubkey currently registered. */
export function streamPubkeys(): string[] {
  return [...registry.keys()];
}

/**
 * Subscribe to registry growth. The listener fires with the newly-added
 * pubkeys whenever {@link registerStreamKeys} admits any. Returns an
 * unsubscribe.
 */
export function onStreamKeysAdded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Sign the NIP-42 AUTH events for all (or a subset of) registered stream keys
 * against `challenge` + `relayUrl`. Signing is local (raw secret keys), so
 * this never touches the user's signer / bunker. Returns the kind-22242
 * events to send on the connection.
 */
export function signStreamAuths(
  challenge: string,
  relayUrl: string,
  pubkeys: Iterable<string> = registry.keys(),
): NostrEvent[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const out: NostrEvent[] = [];
  for (const pk of pubkeys) {
    const sk = registry.get(pk);
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

/** Test seam: forget every registered stream key. */
export function _resetStreamAuthRegistry(): void {
  registry.clear();
}

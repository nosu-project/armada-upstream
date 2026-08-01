import { getArmadaDB } from "@/lib/db/armadaDB";
import { normalizeRelayUrl } from "@/lib/platform";

// ============================================================================
// Relay provenance for the NIP-29 channel directory.
//
// The channel directory (kind-39000 group metadata) is read back from the
// shared local event cache to render instantly on reload. Those events are
// normally scoped by their signing key (`authors: [relaySelf]`), which works
// when each relay has its own identity. But some relay software (e.g. zooid)
// ships a SHARED relay identity, so two different servers advertise the *same*
// NIP-11 `self`/`pubkey`. Author-scoping then can't tell them apart, and one
// server's channels bleed into another's (phantom rooms that "don't exist" when
// opened).
//
// Group ids (`d` tags) aren't globally unique either, so they can't isolate
// same-key relays on their own.
//
// The only reliable discriminator is WHERE the event was actually served from.
// This module records, per directory event, which relay URL(s) returned it, so
// the directory cache can be scoped by relay URL instead of by signing key.
//
// Stored in ArmadaDB's KV, one entry per (relay, event) pair keyed
// `provenance:<relay>\0<eventId>`. The pair belongs in the KEY rather than in a
// per-relay array value because writes are fire-and-forget and concurrent — a
// read-modify-write on a shared array would silently lose batches. Recovering
// the ids is then a prefix scan, and the NUL separator is what stops
// `wss://a.example` from matching `wss://a.example/eu`.
//
// Deliberately NOT stored in a tenant alongside the events themselves: the
// event store keys by event id (a hash of the event) and must never be mutated
// to carry provenance, and provenance is many-to-one (the same event can come
// from several relays). Degrades to a no-op when storage is unavailable.
// ============================================================================

const KEY_PREFIX = "provenance:";

/** Key prefix covering every event id recorded for `relay`. */
function relayPrefix(relay: string): string {
  return `${KEY_PREFIX}${relay}\u0000`;
}

/** KV key for a (relay, event) pair. */
function rowKey(relay: string, eventId: string): string {
  return `${relayPrefix(relay)}${eventId}`;
}

/**
 * Record that `eventId` was served by `relay`. Idempotent (a repeat is a no-op
 * write). Fire-and-forget: failures are swallowed since provenance is a
 * best-effort scoping aid, never on the critical path.
 */
export async function recordRelayProvenance(eventId: string, relayUrl: string): Promise<void> {
  return recordRelayProvenanceBatch([eventId], relayUrl);
}

/** Record provenance for many events from one relay. */
export async function recordRelayProvenanceBatch(
  eventIds: string[],
  relayUrl: string,
): Promise<void> {
  if (eventIds.length === 0) return;
  const relay = normalizeRelayUrl(relayUrl) ?? relayUrl;
  try {
    const kv = getArmadaDB().kv;
    // Issued together rather than sequentially: KV has no batch write, and a
    // directory page is tens to low hundreds of ids off the critical path.
    await Promise.all(eventIds.map((eventId) => kv.set(rowKey(relay, eventId), 1)));
  } catch {
    // best-effort
  }
}

/**
 * The set of event ids known to have been served by `relayUrl`. Returns an
 * empty set when storage is unavailable or nothing is recorded yet — callers
 * treat an empty set as "no provenance info" and fall back accordingly.
 */
export async function eventIdsForRelay(relayUrl: string): Promise<Set<string>> {
  const relay = normalizeRelayUrl(relayUrl) ?? relayUrl;
  try {
    const prefix = relayPrefix(relay);
    const keys = await getArmadaDB().kv.keys(prefix);
    return new Set(keys.map((key) => key.slice(prefix.length)));
  } catch {
    return new Set();
  }
}

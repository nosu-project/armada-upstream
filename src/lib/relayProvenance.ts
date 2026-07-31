import { openDB } from "idb";

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

/** Legacy standalone database, drained by {@link migrateLegacyProvenance}. */
export const LEGACY_PROVENANCE_DB_NAME = "armada-relay-provenance";

const KEY_PREFIX = "provenance:";
const DONE_KEY = "provenance:migrated";

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
    // Lazily, so a relay opened before the startup gate has run still sees the
    // provenance recorded by previous versions.
    await migrateLegacyProvenance();
    const prefix = relayPrefix(relay);
    const keys = await getArmadaDB().kv.keys(prefix);
    return new Set(keys.map((key) => key.slice(prefix.length)));
  } catch {
    return new Set();
  }
}

// ── migration ─────────────────────────────────────────────────────────────────

const LEGACY_STORE = "provenance";

let drain: Promise<void> | undefined;

/**
 * Copy the standalone provenance database into KV. Idempotent; runs at most
 * once per session.
 *
 * Unlike the other drains this data COULD be dropped — it is derived, and a
 * relay re-serving its directory records it again. Copying it anyway is cheap
 * (a bounded number of kind-39000 ids per relay) and avoids the alternative: an
 * empty provenance set makes `useRelayGroups` render nothing from cache until
 * the network read lands, i.e. a blank channel list on the first reload after
 * upgrading.
 */
export function migrateLegacyProvenance(): Promise<void> {
  drain ??= drainLegacyProvenance();
  return drain;
}

async function drainLegacyProvenance(): Promise<void> {
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(DONE_KEY)) return;
  if (typeof indexedDB === "undefined") return;

  try {
    // `openDB` without an upgrade callback still CREATES the database when it
    // is absent — harmless, and the migration deletes it either way.
    const legacy = await openDB(LEGACY_PROVENANCE_DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(LEGACY_STORE)) {
          d.createObjectStore(LEGACY_STORE, { keyPath: "key" });
        }
      },
    });
    const rows = (await legacy.getAll(LEGACY_STORE)) as Array<{ relay: string; eventId: string }>;
    for (const { relay, eventId } of rows) {
      if (typeof relay === "string" && typeof eventId === "string") {
        await db.kv.set(rowKey(relay, eventId), 1);
      }
    }
    legacy.close();
  } catch {
    // Retry next launch rather than marking a partial copy done.
    drain = undefined;
    return;
  }

  await db.kv.set(DONE_KEY, true);
}

/** Test seam: forget the memoised drain so the next read runs it again. */
export async function __resetProvenanceForTests(): Promise<void> {
  drain = undefined;
}

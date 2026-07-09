import { type DBSchema, type IDBPDatabase, openDB } from "idb";

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
// Kept in its OWN tiny IndexedDB database, separate from the event cache: the
// event store keys by event id (a hash of the event) and must never be mutated
// to carry provenance, and provenance is many-to-one (the same event can come
// from several relays). Degrades to a no-op when IndexedDB is unavailable.
// ============================================================================

const DB_NAME = "armada-relay-provenance";
const DB_VERSION = 1;
const STORE = "provenance";

interface ProvenanceDB extends DBSchema {
  [STORE]: {
    /** `${relayUrl}\u0000${eventId}` — one row per (relay, event) pair. */
    key: string;
    value: { key: string; relay: string; eventId: string };
    indexes: { "by-relay": string };
  };
}

let dbPromise: Promise<IDBPDatabase<ProvenanceDB> | null> | undefined;

function getDB(): Promise<IDBPDatabase<ProvenanceDB> | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = openDB<ProvenanceDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("by-relay", "relay");
    },
  }).catch(() => null);
  return dbPromise;
}

/** Compound key for a (relay, event) pair. */
function rowKey(relay: string, eventId: string): string {
  return `${relay}\u0000${eventId}`;
}

/**
 * Record that `eventId` was served by `relay`. Idempotent (a repeat is a no-op
 * put). Fire-and-forget: failures are swallowed since provenance is a
 * best-effort scoping aid, never on the critical path.
 */
export async function recordRelayProvenance(eventId: string, relayUrl: string): Promise<void> {
  const relay = normalizeRelayUrl(relayUrl) ?? relayUrl;
  const db = await getDB();
  if (!db) return;
  try {
    await db.put(STORE, { key: rowKey(relay, eventId), relay, eventId });
  } catch {
    // best-effort
  }
}

/** Record provenance for many events from one relay in a single transaction. */
export async function recordRelayProvenanceBatch(eventIds: string[], relayUrl: string): Promise<void> {
  if (eventIds.length === 0) return;
  const relay = normalizeRelayUrl(relayUrl) ?? relayUrl;
  const db = await getDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    await Promise.all(
      eventIds.map((eventId) => tx.store.put({ key: rowKey(relay, eventId), relay, eventId })),
    );
    await tx.done;
  } catch {
    // best-effort
  }
}

/**
 * The set of event ids known to have been served by `relayUrl`. Returns an
 * empty set when IndexedDB is unavailable or nothing is recorded yet — callers
 * treat an empty set as "no provenance info" and fall back accordingly.
 */
export async function eventIdsForRelay(relayUrl: string): Promise<Set<string>> {
  const relay = normalizeRelayUrl(relayUrl) ?? relayUrl;
  const db = await getDB();
  if (!db) return new Set();
  try {
    const rows = await db.getAllFromIndex(STORE, "by-relay", relay);
    return new Set(rows.map((r) => r.eventId));
  } catch {
    return new Set();
  }
}

/** Test seam: close and reset the cached connection. */
export async function __resetProvenanceForTests(): Promise<void> {
  const prev = dbPromise;
  dbPromise = undefined;
  try {
    const db = await prev;
    db?.close();
  } catch {
    // ignore
  }
}

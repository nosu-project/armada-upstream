import { openDB } from "idb";

import { getArmadaDB } from "@/lib/db/armadaDB";
import { skipLegacyDrain } from "@/lib/db/legacyDatabases";
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
// Stored in ArmadaDB's KV, one entry per (relay, day, event) triple keyed
// `provenance:<relay>\0<day>\0<eventId>`. The pair belongs in the KEY rather
// than in a per-relay array value because writes are fire-and-forget and
// concurrent — a read-modify-write on a shared array would silently lose
// batches. Recovering the ids is then a prefix scan, and the NUL separators are
// what stop `wss://a.example` from matching `wss://a.example/eu`.
//
// THE DAY IS IN THE KEY so the space can be bounded without reading any values.
// Kind-39000 metadata is addressable: every edit mints a new event id, and the
// superseded one is provenance nothing will ever ask about again — so left
// alone this grows with (groups × edits × relays), forever, with no eviction.
// A relay still serving its directory re-records the same ids under today's
// day, so live entries never age out; only ids nobody serves any more do. The
// sweep is then a key scan and some deletes, with no value reads — which
// matters on Android, where each one is a bridge round trip.
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

/**
 * How long an unrefreshed (relay, event) record survives. Comfortably longer
 * than any session, so a relay the user still visits keeps its whole directory
 * — the only thing that expires is provenance for events that stopped being
 * served.
 */
const RETENTION_DAYS = 60;

/** How often a read may pay for a sweep. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

/** Today, as the number of whole days since the epoch. */
function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** Fixed width, so the day sorts lexicographically alongside its neighbours. */
function dayStamp(day: number): string {
  return String(day).padStart(6, "0");
}

/** Key prefix covering every event id recorded for `relay`, on any day. */
function relayPrefix(relay: string): string {
  return `${KEY_PREFIX}${relay}\u0000`;
}

/** KV key for a (relay, day, event) triple. */
function rowKey(relay: string, eventId: string, day = today()): string {
  return `${relayPrefix(relay)}${dayStamp(day)}\u0000${eventId}`;
}

/** The day and event id a key carries, or undefined if it isn't one of ours. */
function parseRow(key: string, prefix: string): { day: number; eventId: string } | undefined {
  const rest = key.slice(prefix.length);
  const split = rest.indexOf("\u0000");
  if (split < 0) return undefined;
  const day = Number(rest.slice(0, split));
  const eventId = rest.slice(split + 1);
  if (!Number.isInteger(day) || !eventId) return undefined;
  return { day, eventId };
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
 *
 * Also where the retention sweep happens, throttled: this is the only read, so
 * it is the only place that knows a relay is still in use, and it has the key
 * list in hand already.
 */
export async function eventIdsForRelay(relayUrl: string): Promise<Set<string>> {
  const relay = normalizeRelayUrl(relayUrl) ?? relayUrl;
  try {
    // Lazily, so a relay opened before the startup gate has run still sees the
    // provenance recorded by previous versions.
    await migrateLegacyProvenance();
    const prefix = relayPrefix(relay);
    const keys = await getArmadaDB().kv.keys(prefix);

    const now = today();
    const cutoff = now - RETENTION_DAYS;
    const ids = new Set<string>();
    const stale: string[] = [];

    for (const key of keys) {
      const row = parseRow(key, prefix);
      // A key that doesn't parse predates the day-stamped format. Provenance is
      // derived — the next directory read records it again — so it is swept
      // rather than read, which keeps this function knowing exactly one shape.
      if (!row) {
        stale.push(key);
        continue;
      }
      if (row.day < cutoff) {
        stale.push(key);
        continue;
      }
      ids.add(row.eventId);
    }

    if (stale.length > 0) void sweep(stale);
    return ids;
  } catch {
    return new Set();
  }
}

let lastSweepAt = 0;

/** Drop expired and unparseable rows, at most once every {@link SWEEP_INTERVAL_MS}. */
async function sweep(keys: string[]): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  try {
    const kv = getArmadaDB().kv;
    await Promise.all(keys.map((key) => kv.delete(key).catch(() => undefined)));
  } catch {
    // best-effort: the rows are re-swept on the next read
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
 *
 * Copied rows are stamped with TODAY rather than the day they were originally
 * recorded, which the legacy database never kept. That is the right direction:
 * a relay still in use refreshes them on its next directory read, and one that
 * isn't lets them expire {@link RETENTION_DAYS} from the upgrade instead of
 * immediately.
 */
export function migrateLegacyProvenance(): Promise<void> {
  drain ??= drainLegacyProvenance().catch((err: unknown) => {
    // Retry next launch rather than marking a partial copy done. Re-reported
    // so the startup gate doesn't delete the source of an unfinished copy.
    drain = undefined;
    throw err;
  });
  return drain;
}

async function drainLegacyProvenance(): Promise<void> {
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(DONE_KEY)) return;
  if (typeof indexedDB === "undefined") return;
  // `openDB` CREATES the database when it is absent; see `skipLegacyDrain`.
  if (await skipLegacyDrain(LEGACY_PROVENANCE_DB_NAME)) return;

  const legacy = await openDB(LEGACY_PROVENANCE_DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(LEGACY_STORE)) {
        d.createObjectStore(LEGACY_STORE, { keyPath: "key" });
      }
    },
  });
  try {
    const rows = (await legacy.getAll(LEGACY_STORE)) as Array<{ relay: string; eventId: string }>;
    for (const { relay, eventId } of rows) {
      if (typeof relay === "string" && typeof eventId === "string") {
        await db.kv.set(rowKey(relay, eventId), 1);
      }
    }
  } finally {
    legacy.close();
  }

  await db.kv.set(DONE_KEY, true);
}

/** Test seam: forget the memoised drain and the sweep throttle. */
export async function __resetProvenanceForTests(): Promise<void> {
  drain = undefined;
  lastSweepAt = 0;
}

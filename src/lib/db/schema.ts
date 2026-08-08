/**
 * ArmadaDB's data-schema version, and the migrations between versions.
 *
 * Distinct from the IndexedDB `version` numbers the adapter passes to
 * `openDB` (see `KV_DB_VERSION` in `IndexedDBArmadaDB.ts`). Those describe the
 * STORE LAYOUT of one database — which object stores and indexes exist — and
 * IndexedDB itself runs their upgrade transaction. This describes the CONTENT:
 * how rumors are tagged, how KV keys are spelled, which tenants hold what.
 * IndexedDB knows nothing about any of that, the SQLite adapter has its own
 * unrelated DDL, and a content change usually has to rewrite rows across
 * several databases at once — so it needs a version of its own, stored in KV
 * where both adapters can reach it.
 *
 * The rule for changing the stored shape from here on: don't rewrite a reader
 * to cope with two shapes. Add a {@link SchemaMigration}, bump
 * {@link ARMADA_DB_VERSION}, and let the gate convert the data once.
 */
import { ARMADA_TENANTS, getArmadaDB } from "./armadaDB";
import { isRelayScoped, RELAY_STATE_KINDS } from "./relayScope";

/**
 * The shape this build writes and expects.
 *
 * 1 — the initial ArmadaDB layout: one tenant per community / DM inbox /
 *     invite inbox plus `main` and `c2park`, KV holding folds, cursors, the
 *     decrypt cache, relay provenance, the publish outbox, and Concord seals.
 * 2 — the unbounded localStorage key spaces move into KV behind
 *     `KvPrefixCache`: composer drafts, NIP-11 relay info, favorite-GIF
 *     shards, wire cursors, control-plane watchdog dismissals, and pending
 *     read cuts.
 * 3 — NIP-29 moves out of `main` into a tenant per relay (`nip29:<url>`), and
 *     the `provenance:` KV space that used to reconstruct which relay served
 *     each directory event goes away with it. See `relayScope.ts`.
 */
export const ARMADA_DB_VERSION = 3;

/** The retired relay-provenance KV space, dropped by version 3. */
const PROVENANCE_PREFIX = "provenance:";

/** KV key holding the version of the data actually on disk. */
export const SCHEMA_VERSION_KEY = "db:version";

export interface SchemaMigration {
  /** The version reached by running this. Must be unique and ascending. */
  to: number;
  /** Shown as a line in the gate's progress list. */
  label: string;
  /**
   * Whether the conversion is per-account, i.e. it touches a tenant or KV key
   * whose name embeds a pubkey. Runs once per logged-in account, with `self`
   * set; otherwise once, with `self` undefined.
   *
   * A per-account conversion CANNOT assume it will ever see every account: an
   * account that logs in tomorrow arrives with the version already stamped. So
   * it must be safe to leave un-run for an account — convert lazily on read,
   * or write the new shape alongside the old rather than replacing it.
   */
  perAccount?: boolean;
  /**
   * Whether there is anything to convert, checked before the gate decides to
   * show itself. Defaults to yes.
   *
   * This is what keeps a fresh install quiet. An unstamped database is either
   * a fresh install or one predating the version key, and they are told apart
   * only by whether the old shape's data is actually there.
   */
  needed?(): Promise<boolean>;
  /** Convert the data. Must be idempotent: a failed run is retried whole. */
  run(self: string | undefined): Promise<void>;
}

/**
 * The localStorage key spaces version 2 moves into KV, and where each lands.
 *
 * This table is the ONLY place the old spelling of these keys is written down.
 * The caches that own the new prefixes (see `KvPrefixCache`) know nothing about
 * localStorage: they read KV and only KV, so a value is either moved here, once,
 * or it is not moved at all. Ids line up on both sides — `from + id` is the same
 * entry as `to + id` — which is what makes the move a rename rather than a
 * re-encoding.
 */
export const LOCALSTORAGE_MOVES: Array<{ from: string; to: string }> = [
  /** Composer drafts (`ChatComposer`). */
  { from: "chat-draft:", to: "draft:" },
  /** NIP-11 relay documents (`useRelayInfo`). */
  { from: "armada:relay-info:", to: "relay-info:" },
  /** Favorite-GIF shards and their merge (`useFavoriteGifs`). */
  { from: "armada:favorite-gifs:shard:", to: "favorite-gifs-shard:" },
  { from: "armada:favorite-gifs:merged:", to: "favorite-gifs-merged:" },
  /** Wire sync cursors (`WireSync`). */
  { from: "armada:wire-cursor:", to: "wire-cursor:" },
  /** Control-plane watchdog dismissals (`useSuspiciousActivity`). */
  { from: "armada:cp-watchdog:", to: "cp-watchdog:" },
  /** Pending read cuts (`readCutPending`). */
  { from: "concord2:read-cut-pending:", to: "read-cut-pending:" },
];

/** Every localStorage key under one of the moved prefixes. */
function movedKeys(): Array<{ key: string; to: string }> {
  if (typeof localStorage === "undefined") return [];
  const out: Array<{ key: string; to: string }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const move = LOCALSTORAGE_MOVES.find((m) => key.startsWith(m.from));
      if (move) out.push({ key, to: move.to + key.slice(move.from.length) });
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * The value behind a legacy key. These were `JSON.stringify`d, but a couple of
 * writers stored a bare string or number, so an unparseable value is kept as
 * the string it is rather than dropped.
 */
function parseLegacy(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Kinds that MIGHT be relay-scoped, so the version-3 sweep has a bounded set of
 * rows to look at instead of walking all of `main`.
 *
 * A superset on purpose, and filtered by {@link isRelayScoped} per row: kinds 5,
 * 7 and 1111 double as ordinary global deletes, reactions and comments, and those
 * belong in `main` and must survive. Anything group-scoped this list misses is
 * left behind as dead weight, not as a bug — no reader queries `main` for
 * relay-scoped data any more, so a leftover row is unreachable rather than wrong.
 */
const RELAY_SCOPED_CANDIDATE_KINDS = [
  5, 7, 9, 11, 12, 1068, 1111, 9450,
  9000, 9001, 9002, 9005, 9007, 9008, 9009, 9010, 9021, 9022,
  31922, 31923, 31925,
  ...RELAY_STATE_KINDS,
];

/** One page of `main` rows to examine per sweep pass. */
const SWEEP_PAGE = 500;

/** Ordered by `to`, ascending. */
export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    to: 2,
    label: "Moving drafts and caches",
    needed: () => Promise.resolve(movedKeys().length > 0),
    /**
     * Copy each entry into KV, then remove it from localStorage.
     *
     * The localStorage entry is dropped only after the KV write is confirmed
     * readable. KV degrades to a silent no-op where IndexedDB is unavailable
     * (iOS Lockdown Mode, some private-browsing contexts), so deleting on the
     * strength of an unverified write would discard the data on exactly the
     * devices least able to spare it.
     *
     * An entry already present in KV is not overwritten: this build writes
     * through to KV from the first frame, so a value written since boot is
     * newer than the localStorage copy the migration is walking.
     */
    async run() {
      const entries = movedKeys();
      if (entries.length === 0) return;

      const { kv } = getArmadaDB();
      for (const { key, to } of entries) {
        try {
          const raw = localStorage.getItem(key);
          if (raw !== null) {
            const value = parseLegacy(raw);
            if (value !== undefined && (await kv.get(to)) === undefined) {
              await kv.set(to, value);
              // Confirm the write landed before dropping the only other copy.
              if ((await kv.get(to)) === undefined) continue;
            }
          }
          localStorage.removeItem(key);
        } catch {
          // Leave this entry for the next launch; the rest still move.
        }
      }

      // A cache that warmed before this ran holds an empty map for a prefix
      // that now has values, and nothing else would tell it otherwise. Dropping
      // the maps makes the next read re-warm and notifies live subscribers.
      const { resetKvCaches } = await import("./kvCache");
      resetKvCaches();
    },
  },
  {
    to: 3,
    label: "Separating servers' channels",
    /**
     * Anything relay-scoped still sitting in `main` is orphaned, because nothing
     * reads `main` for it now — the readers ask a relay's own tenant. Reclaim the
     * space, and drop the provenance side-table the relay tenants replace.
     *
     * Nothing is MOVED, and that is the point: these rows are exactly the ones
     * whose source relay was never recorded, which is the whole reason they had
     * to leave `main`. There is no honest tenant to move them to — inventing one
     * would re-file another server's channel under this one and reintroduce the
     * bleed. They are also the cheapest possible loss: a NIP-29 event is
     * refetchable from the single relay that hosts it, and the timelines re-read
     * from the relay on mount anyway.
     */
    needed: async () => {
      try {
        const main = getArmadaDB().tenant(ARMADA_TENANTS.main);
        const { count } = await main.count([
          { kinds: RELAY_SCOPED_CANDIDATE_KINDS, limit: 1 },
        ]);
        if (count > 0) return true;
        // Only whether ANY provenance key is left, so stop the scan at the first.
        const [any] = await getArmadaDB().kv.list({ prefix: PROVENANCE_PREFIX }, { limit: 1 });
        return any !== undefined;
      } catch {
        return false;
      }
    },
    async run() {
      const db = getArmadaDB();
      const main = db.tenant(ARMADA_TENANTS.main);

      // Walk newest-first in pages, stepping `until` past each page. Deleting
      // only SOME of a page is why the cursor is needed at all: a page whose
      // rows all belong in `main` would otherwise be re-read forever.
      let until: number | undefined;
      for (;;) {
        const page = await main.query([
          { kinds: RELAY_SCOPED_CANDIDATE_KINDS, limit: SWEEP_PAGE, ...(until ? { until } : {}) },
        ]);
        if (page.length === 0) break;
        const ids = page.filter((rumor) => isRelayScoped(rumor)).map((rumor) => rumor.id);
        if (ids.length > 0) await main.remove([{ ids }]);
        const oldest = Math.min(...page.map((rumor) => rumor.created_at));
        // A page entirely within one second can't be stepped past by timestamp;
        // if everything in it was deleted the next pass makes progress anyway,
        // and if none of it was there is nothing left to find below it.
        if (page.length < SWEEP_PAGE) break;
        if (until !== undefined && oldest >= until) break;
        until = oldest;
      }

      // The provenance space: (relay, day, event id) keys and its drain marker.
      for (const { key } of await db.kv.list({ prefix: PROVENANCE_PREFIX })) {
        await db.kv.delete(key).catch(() => undefined);
      }
    },
  },
];

/** The version on disk, or `undefined` if it was never stamped. */
export async function readSchemaVersion(): Promise<number | undefined> {
  try {
    const stored = await getArmadaDB().kv.get<number>(SCHEMA_VERSION_KEY);
    return typeof stored === "number" && Number.isInteger(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** Record that the data on disk is now at `version`. */
export async function stampSchemaVersion(version: number = ARMADA_DB_VERSION): Promise<void> {
  await getArmadaDB().kv.set(SCHEMA_VERSION_KEY, version);
}

/**
 * The migrations still owed, given the version on disk.
 *
 * An unstamped database counts as version 0, so a profile predating the
 * version key is offered every conversion. That is only safe because each one
 * declares whether it has anything to do: a fresh install is unstamped too,
 * and is told apart from an old profile by {@link SchemaMigration.needed}
 * rather than by the version alone.
 *
 * A version AHEAD of this build (the user downgraded, or ran an older tab
 * against a newer profile) owes nothing, and gets nothing: the data is in a
 * shape this build didn't write, and the migrations that produced it only run
 * forwards. Reads degrade as they degrade; a "migration" invented here would be
 * a guess at a shape that didn't exist when this code was written.
 */
export async function pendingSchemaMigrations(
  from: number | undefined,
): Promise<SchemaMigration[]> {
  if (isFutureVersion(from)) return [];
  const at = from ?? 0;
  const candidates = SCHEMA_MIGRATIONS.filter((m) => m.to > at && m.to <= ARMADA_DB_VERSION)
    .sort((a, b) => a.to - b.to);

  const owed: SchemaMigration[] = [];
  for (const m of candidates) {
    // Skipping a conversion with nothing to convert does not strand the
    // version: the caller stamps the current version either way. It only means
    // no upgrade overlay for an origin that has nothing to upgrade.
    if (!m.needed || (await m.needed().catch(() => true))) owed.push(m);
  }
  return owed;
}

/** Whether the data on disk was written by a newer build than this one. */
export function isFutureVersion(from: number | undefined): boolean {
  return from !== undefined && from > ARMADA_DB_VERSION;
}

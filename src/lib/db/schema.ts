/**
 * ArmadaDB's data-schema version (CONTENT shape: tagging, KV key spelling,
 * tenant layout) and its migrations, stored in KV. Distinct from IndexedDB
 * store-layout versions (`KV_DB_VERSION`). To change the stored shape, add a
 * {@link SchemaMigration} and bump {@link ARMADA_DB_VERSION} — don't make readers
 * cope with two shapes.
 */
import { ARMADA_TENANTS, getArmadaDB } from "./armadaDB";
import { isRelayScoped, RELAY_STATE_KINDS } from "./relayScope";

/**
 * The shape this build writes and expects.
 * 1 — initial ArmadaDB layout.
 * 2 — unbounded localStorage key spaces move into KV (`KvPrefixCache`).
 * 3 — NIP-29 moves from `main` to per-relay tenants; `provenance:` KV dropped.
 */
export const ARMADA_DB_VERSION = 3;

const PROVENANCE_PREFIX = "provenance:";

export const SCHEMA_VERSION_KEY = "db:version";

export interface SchemaMigration {
  /** Version reached by running this; unique and ascending. */
  to: number;
  label: string;
  /**
   * Runs once per logged-in account with `self`. Must be safe to leave un-run
   * for an account (later logins arrive already stamped).
   */
  perAccount?: boolean;
  /**
   * Whether there is anything to convert (default yes); tells a fresh install
   * (unstamped) from a pre-version-key one, keeping fresh installs quiet.
   */
  needed?(): Promise<boolean>;
  run(self: string | undefined): Promise<void>;
}

/**
 * localStorage key spaces moved to KV by version 2: the ONLY record of the old
 * spellings. `from + id` renames to `to + id`.
 */
export const LOCALSTORAGE_MOVES: Array<{ from: string; to: string }> = [
  { from: "chat-draft:", to: "draft:" },
  { from: "armada:relay-info:", to: "relay-info:" },
  { from: "armada:favorite-gifs:shard:", to: "favorite-gifs-shard:" },
  { from: "armada:favorite-gifs:merged:", to: "favorite-gifs-merged:" },
  { from: "armada:wire-cursor:", to: "wire-cursor:" },
  { from: "armada:cp-watchdog:", to: "cp-watchdog:" },
  { from: "concord2:read-cut-pending:", to: "read-cut-pending:" },
];

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

/** A legacy value: JSON, or kept as a raw string if a writer stored one bare. */
function parseLegacy(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Kinds that MIGHT be relay-scoped, bounding the version-3 sweep; filtered per
 * row by {@link isRelayScoped} (5/7/1111 are also global). Misses are only
 * unreachable dead weight.
 */
const RELAY_SCOPED_CANDIDATE_KINDS = [
  5, 7, 9, 11, 12, 1068, 1111, 9450,
  9000, 9001, 9002, 9005, 9007, 9008, 9009, 9010, 9021, 9022,
  31922, 31923, 31925,
  ...RELAY_STATE_KINDS,
];

const SWEEP_PAGE = 500;

/** Ordered by `to`, ascending. */
export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    to: 2,
    label: "Moving drafts and caches",
    needed: () => Promise.resolve(movedKeys().length > 0),
    /**
     * Copy each entry into KV, removing it from localStorage only once the KV
     * write reads back (KV no-ops without IndexedDB). Existing KV entries win
     * (written through since boot, so newer).
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
              if ((await kv.get(to)) === undefined) continue;
            }
          }
          localStorage.removeItem(key);
        } catch {
          // Leave this entry for the next launch; the rest still move.
        }
      }

      // Caches warmed before this ran hold empty maps; reset to re-warm.
      const { resetKvCaches } = await import("./kvCache");
      resetKvCaches();
    },
  },
  {
    to: 3,
    label: "Separating servers' channels",
    /**
     * Delete relay-scoped rows orphaned in `main` and the provenance KV space.
     * Nothing is MOVED: their source relay was never recorded, and guessing
     * would reintroduce the cross-server bleed. They're refetchable.
     */
    needed: async () => {
      try {
        const main = getArmadaDB().tenant(ARMADA_TENANTS.main);
        const { count } = await main.count([
          { kinds: RELAY_SCOPED_CANDIDATE_KINDS, limit: 1 },
        ]);
        if (count > 0) return true;
        const [any] = await getArmadaDB().kv.list({ prefix: PROVENANCE_PREFIX }, { limit: 1 });
        return any !== undefined;
      } catch {
        return false;
      }
    },
    async run() {
      const db = getArmadaDB();
      const main = db.tenant(ARMADA_TENANTS.main);

      // Newest-first pages; partial deletes need the `until` cursor.
      let until: number | undefined;
      for (;;) {
        const page = await main.query([
          { kinds: RELAY_SCOPED_CANDIDATE_KINDS, limit: SWEEP_PAGE, ...(until ? { until } : {}) },
        ]);
        if (page.length === 0) break;
        const ids = page.filter((rumor) => isRelayScoped(rumor)).map((rumor) => rumor.id);
        if (ids.length > 0) await main.remove([{ ids }]);
        const oldest = Math.min(...page.map((rumor) => rumor.created_at));
      // A single-second page can't be stepped past; stop.
        if (page.length < SWEEP_PAGE) break;
        if (until !== undefined && oldest >= until) break;
        until = oldest;
      }

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
 * Migrations still owed. Unstamped counts as 0 ({@link SchemaMigration.needed}
 * tells fresh installs apart). A version ahead of this build (downgrade) owes
 * nothing: migrations only run forwards.
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
    // Skipping an unneeded one doesn't strand the version (the caller stamps anyway).
    if (!m.needed || (await m.needed().catch(() => true))) owed.push(m);
  }
  return owed;
}

/** Whether the data on disk was written by a newer build than this one. */
export function isFutureVersion(from: number | undefined): boolean {
  return from !== undefined && from > ARMADA_DB_VERSION;
}

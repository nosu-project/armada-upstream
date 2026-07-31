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
import { getArmadaDB } from "./armadaDB";

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
 */
export const ARMADA_DB_VERSION = 2;

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

/** Whether any localStorage key starts with one of `prefixes`. */
function anyLocalStorageKey(prefixes: string[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && prefixes.some((p) => key.startsWith(p))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** The localStorage prefixes version 2 drains, in the order listed above. */
const V2_LEGACY_PREFIXES = [
  "chat-draft:",
  "armada:relay-info:",
  "armada:favorite-gifs:shard:",
  "armada:favorite-gifs:merged:",
  "armada:wire-cursor:",
  "armada:cp-watchdog:",
  "concord2:read-cut-pending:",
];

/** Ordered by `to`, ascending. */
export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    to: 2,
    label: "Moving drafts and caches",
    needed: () => Promise.resolve(anyLocalStorageKey(V2_LEGACY_PREFIXES)),
    // Each cache drains its own prefix as part of loading, so the conversion
    // is just "load them all" — the same code path an ordinary read takes,
    // rather than a second copy of the mapping that could drift from it.
    // Importing here (not at module scope) keeps the UI modules that own these
    // caches out of the migration's import graph until it actually runs.
    async run() {
      const [{ warmKvCaches }] = await Promise.all([
        import("./kvCache"),
        // Registration is a side effect of constructing a cache, so every
        // owning module has to be loaded before `warmKvCaches` can see it.
        import("@/components/chat/ChatComposer"),
        import("@/hooks/useRelayInfo"),
        import("@/hooks/useFavoriteGifs"),
        import("@/wire/WireSync"),
        import("@/concord-v2/hooks/useSuspiciousActivity2"),
        import("@/concord-v2/lib/readCutPending"),
      ]);
      await warmKvCaches();
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

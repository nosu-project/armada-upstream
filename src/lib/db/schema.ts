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
 */
export const ARMADA_DB_VERSION = 1;

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
  /** Convert the data. Must be idempotent: a failed run is retried whole. */
  run(self: string | undefined): Promise<void>;
}

/**
 * Ordered by `to`, ascending. Empty because nothing has changed since
 * {@link ARMADA_DB_VERSION} 1 — the entry point exists so the first change
 * doesn't have to invent the mechanism under pressure.
 */
export const SCHEMA_MIGRATIONS: SchemaMigration[] = [];

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
 * An unstamped database owes nothing on its own: it is either a fresh install
 * or one predating the version key, and both are at {@link ARMADA_DB_VERSION}
 * once the legacy drains have run. So the caller stamps and moves on.
 *
 * A version AHEAD of this build (the user downgraded, or ran an older tab
 * against a newer profile) owes nothing either, and gets nothing: the data is
 * in a shape this build didn't write, and the migrations that produced it only
 * run forwards. Reads degrade as they degrade; a "migration" invented here
 * would be a guess at a shape that didn't exist when this code was written.
 */
export function pendingSchemaMigrations(from: number | undefined): SchemaMigration[] {
  if (from === undefined) return [];
  return SCHEMA_MIGRATIONS.filter((m) => m.to > from && m.to <= ARMADA_DB_VERSION)
    .sort((a, b) => a.to - b.to);
}

/** Whether the data on disk was written by a newer build than this one. */
export function isFutureVersion(from: number | undefined): boolean {
  return from !== undefined && from > ARMADA_DB_VERSION;
}

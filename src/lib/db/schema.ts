/**
 * ArmadaDB's data-schema version (CONTENT shape: tagging, KV key spelling,
 * tenant layout) and its migrations, stored in KV. Distinct from IndexedDB
 * store-layout versions (`KV_DB_VERSION`). To change the stored shape, add a
 * {@link SchemaMigration} and bump {@link ARMADA_DB_VERSION} — don't make readers
 * cope with two shapes.
 */
import { getArmadaDB } from "./armadaDB";

/**
 * The shape this build writes and expects.
 * 1 — initial ArmadaDB layout.
 * 2 — unbounded localStorage key spaces move into KV (`KvPrefixCache`).
 * 3 — NIP-29 moves from `main` to per-relay tenants; `provenance:` KV dropped.
 */
export const ARMADA_DB_VERSION = 3;

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

/** Ordered by `to`, ascending. */
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

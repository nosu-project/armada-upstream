/** Runs ArmadaDB schema migrations (see `schema.ts`); triggered by {@link DBMigrationGate}. */
import {
  ARMADA_DB_VERSION,
  isFutureVersion,
  pendingSchemaMigrations,
  readSchemaVersion,
  stampSchemaVersion,
  type SchemaMigration,
} from "./schema";

export interface PendingUpgrades {
  /** Schema conversions owed for the version on disk. */
  schema: SchemaMigration[];
  /** The data was written by a newer build; nothing will be run against it. */
  future: boolean;
}

/** What {@link runMigrations} would actually do, without doing any of it. */
export async function pendingUpgrades(): Promise<PendingUpgrades> {
  const version = await readSchemaVersion();
  return {
    schema: await pendingSchemaMigrations(version),
    future: isFutureVersion(version),
  };
}

/** Stamp the current version, never moving a newer build's stamp backwards. */
async function stampCurrentVersion(): Promise<void> {
  const from = await readSchemaVersion();
  if (isFutureVersion(from) || from === ARMADA_DB_VERSION) return;
  await stampSchemaVersion();
}

/** Mark an origin with nothing to migrate as up to date. */
export async function markUpToDate(): Promise<void> {
  await stampCurrentVersion();
}

export interface MigrationProgress {
  label: string;
  done: number;
  total: number;
}

/**
 * Bring the origin up to {@link ARMADA_DB_VERSION}: apply schema conversions
 * for every account, then stamp the version.
 */
export async function runMigrations(
  accounts: string[],
  onProgress?: (progress: MigrationProgress) => void,
): Promise<void> {
  const version = await readSchemaVersion();
  // Written by a newer build: leave the data exactly as found.
  if (isFutureVersion(version)) return;

  const schemaJobs = (await pendingSchemaMigrations(version)).map((m) => ({
    migration: m,
    selves: m.perAccount ? accounts : [undefined as string | undefined],
  }));

  const total = schemaJobs.reduce((n, s) => n + s.selves.length, 0);
  let done = 0;

  for (const { migration, selves } of schemaJobs) {
    for (const self of selves) {
      onProgress?.({ label: migration.label, done, total });
      try {
        await migration.run(self);
      } catch {
        // Stop: versions apply in order; unstamped, so the next launch retries.
        return;
      }
      done++;
    }
    // Stamped per step (after all accounts) so an interrupted run resumes.
    await stampSchemaVersion(migration.to);
  }

  await stampCurrentVersion();
}

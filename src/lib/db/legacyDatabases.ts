/**
 * Shared state for the pre-ArmadaDB drains (separate module to avoid a cycle
 * with `migrations.ts`). Answers "is there anything to drain?": opening a
 * legacy database CREATES it, which would make the startup gate show an
 * upgrade overlay on every launch.
 */
import { getArmadaDB } from "./armadaDB";

/** Set once every drain has run and legacy DBs are gone; drains' fast path. */
export const MIGRATIONS_COMPLETE_KEY = "migrations:complete";

/**
 * Thrown by a drain that can't run YET (e.g. key material not cached for this
 * account). Rejects like a failure so the source DB is never deleted uncopied.
 */
export class MigrationDeferredError extends Error {
  constructor(reason: string) {
    super(`Migration deferred: ${reason}`);
    this.name = "MigrationDeferredError";
  }
}

/**
 * Memo for {@link legacyMigrationsComplete}, shared by the gate, every drain
 * and the fold-cache drain on the boot critical path. Only `true` is cached
 * (the flag is never cleared); an in-flight promise is shared.
 */
let complete = false;
let completeInFlight: Promise<boolean> | undefined;

/** Whether the startup gate has already finished every drain. */
export async function legacyMigrationsComplete(): Promise<boolean> {
  if (complete) return true;
  completeInFlight ??= (async () => {
    try {
      return (await getArmadaDB().kv.get<boolean>(MIGRATIONS_COMPLETE_KEY)) === true;
    } catch {
      return false;
    }
  })().then(
    (value) => {
      complete = value;
      completeInFlight = undefined;
      return value;
    },
    () => {
      completeInFlight = undefined;
      return false;
    },
  );
  return completeInFlight;
}

/** Test seam: forget the memoised completion flag. */
export function __resetLegacyMigrationsMemoForTests(): void {
  complete = false;
  completeInFlight = undefined;
}

/**
 * Whether a legacy database exists, or `undefined` when unknowable (Firefox).
 * Don't collapse `undefined`: absent loses data, present re-creates DBs forever.
 */
export async function legacyDatabaseExists(name: string): Promise<boolean | undefined> {
  if (typeof indexedDB === "undefined") return false;
  if (typeof indexedDB.databases !== "function") return undefined;
  try {
    return (await indexedDB.databases()).some((d) => d.name === name);
  } catch {
    return undefined;
  }
}

/**
 * Whether a drain should return without opening `name`: gate complete, or DB
 * demonstrably absent. Unknowable falls through (safe; costs one empty DB once).
 */
export async function skipLegacyDrain(name: string): Promise<boolean> {
  if (await legacyMigrationsComplete()) return true;
  return (await legacyDatabaseExists(name)) === false;
}

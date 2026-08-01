/**
 * Shared state for the pre-ArmadaDB drains.
 *
 * Lives in its own module rather than in `migrations.ts` because the catalogue
 * imports every drain, so anything a drain imports back from the catalogue is a
 * cycle.
 *
 * Two things live here, and both exist to answer the same question from the
 * drain's side: *is there anything to drain at all?* Getting that wrong is not
 * cosmetic. A drain that opens a legacy database CREATES it — `openDB` and
 * `NIndexedDB` both do — so a device that never had one ends up with an empty
 * database named exactly like the thing the startup gate looks for, and the
 * gate then shows a storage-upgrade overlay to a user who has nothing to
 * upgrade, on every launch after their first.
 */
import { getArmadaDB } from "./armadaDB";

/**
 * Set once every drain has run for every account and the legacy databases are
 * gone. Read by the drains as a fast path, so they never re-open (and so never
 * re-create) a database the gate has already finished with.
 */
export const MIGRATIONS_COMPLETE_KEY = "migrations:complete";

/**
 * Thrown by a drain that cannot run YET but has not failed — the usual case
 * being that the key material it needs to interpret the legacy data hasn't
 * been cached for this account yet.
 *
 * It reaches the catalogue as an ordinary rejection, which is the point: the
 * only thing that must not happen is deleting a database nobody has copied.
 * The separate type exists so the reason is legible at the throw site, and so
 * a future caller can tell "come back later" from "this broke".
 */
export class MigrationDeferredError extends Error {
  constructor(reason: string) {
    super(`Migration deferred: ${reason}`);
    this.name = "MigrationDeferredError";
  }
}

/**
 * Memo for {@link legacyMigrationsComplete}.
 *
 * Everything that asks shares ONE read: the startup gate's probe, every drain's
 * `skipLegacyDrain`, and the lazy fold-cache drain that sits in front of every
 * `readFolded`/`writeFolded`. Uncached, each of those paid its own KV round trip
 * (a Capacitor bridge round trip on Android) serially AHEAD of the read it was
 * guarding — so the first fold read of a session, which is on the boot critical
 * path, cost two sequential reads to answer one question.
 *
 * Only `true` is cached, and it is cached for the process: the flag is set once
 * by the gate and never cleared, whereas a cached `false` would pin every drain
 * to "not done" for the rest of a session in which the gate then finished. While
 * a read is in flight the promise itself is the memo, so concurrent askers join
 * it rather than issuing their own.
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
 * Whether a legacy database is present at the origin, or `undefined` when the
 * browser won't say (Firefox has no `indexedDB.databases()`).
 *
 * `undefined` is deliberately not collapsed to `true`/`false`: a caller that
 * treats "don't know" as absent would skip a real drain and lose data, and one
 * that treats it as present would re-create empty databases forever.
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
 * Whether a drain should return immediately without opening `name`.
 *
 * True when the gate has already completed every migration, or when the
 * database demonstrably isn't there. An unknowable answer (Firefox) falls
 * through to the drain, which is the safe direction: it costs one empty
 * database on a fresh install, and the complete flag stops that recurring.
 */
export async function skipLegacyDrain(name: string): Promise<boolean> {
  if (await legacyMigrationsComplete()) return true;
  return (await legacyDatabaseExists(name)) === false;
}

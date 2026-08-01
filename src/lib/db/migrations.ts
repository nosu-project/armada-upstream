/**
 * Forward-migration of the pre-ArmadaDB IndexedDB databases.
 *
 * Armada used to keep each subsystem in its own hand-rolled IndexedDB
 * database. Those are being folded into ArmadaDB, one subsystem at a time, and
 * every one of them holds data that cannot simply be dropped — decrypted
 * messages whose gift wraps relays may no longer have, invites the sync cursor
 * has already passed, a decrypt cache whose loss means a bunker round-trip per
 * message.
 *
 * So each subsystem owns a drain that copies its data forward, and this module
 * is the catalogue: what the drains are, which databases they consume, and
 * whether a drain runs once or once per account. The drains are individually
 * idempotent and memoised, so running them again costs a KV read.
 *
 * Two things trigger them:
 *
 *  - {@link DBMigrationGate}, at startup, for every logged-in account at once —
 *    the only path that can then DELETE the old databases, since it is the
 *    only one that knows no other account still needs them.
 *  - The owning module's own read path, lazily, so an account that logs in
 *    later still migrates without waiting for the next launch.
 */
import { migrateLegacyInvites } from "@/concord-v2/lib/inviteInbox";
import { DECRYPT_CACHE_DB_NAME } from "@/lib/AppSigner";
import { LEGACY_RUMOR_DB_NAME, migrateLegacyRumors } from "@/concord-v2/lib/rumorMigration";
import { migrateLegacyDms } from "@/lib/nip17/dm17Store";
import { migrateLegacyDecryptCache } from "@/lib/decryptCacheMigration";
import { LEGACY_PROVENANCE_DB_NAME, migrateLegacyProvenance } from "@/lib/relayProvenance";
import { LEGACY_FOLDED_DB_NAME, migrateLegacyFolded } from "@/lib/foldedCache";

import { getArmadaDB } from "./armadaDB";
import { LEGACY_EVENT_DB_NAME, migrateLegacyEvents } from "./eventStoreMigration";
import { MIGRATIONS_COMPLETE_KEY } from "./legacyDatabases";
import {
  ARMADA_DB_VERSION,
  isFutureVersion,
  pendingSchemaMigrations,
  readSchemaVersion,
  stampSchemaVersion,
  type SchemaMigration,
} from "./schema";

export interface Migration {
  /** Stable id (appears in no storage key — the drains own their own flags). */
  id: string;
  /** Shown as a line in the gate's progress list. */
  label: string;
  /** Legacy databases this drain reads. Deleted once every account is done. */
  legacy: string[];
  /**
   * Whether the drain is per-account. Per-account data was stored in one
   * global database, so it can only be deleted after EVERY logged-in account
   * has taken its share out.
   */
  perAccount: boolean;
  run(self: string | undefined): Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    // First, because the `c2-rumors` drain reads folds to attribute rumors to
    // communities. That ordering isn't load-bearing — `readFolded` awaits this
    // drain itself, so a lazy trigger outside the gate is safe too — but the
    // dependency is real and the list may as well show it.
    id: "folded",
    label: "Moving cached community data",
    legacy: [LEGACY_FOLDED_DB_NAME],
    perAccount: false,
    run: () => migrateLegacyFolded(),
  },
  {
    id: "decrypt-cache",
    label: "Moving the decrypt cache",
    legacy: [DECRYPT_CACHE_DB_NAME],
    perAccount: false,
    run: () => migrateLegacyDecryptCache(),
  },
  {
    id: "invites",
    label: "Moving community invites",
    legacy: ["armada-concord-invites"],
    perAccount: true,
    run: (self) => migrateLegacyInvites(self!),
  },
  {
    id: "dm17",
    label: "Moving private messages",
    legacy: ["armada-dm17-rumors"],
    perAccount: true,
    run: (self) => migrateLegacyDms(self!),
  },
  {
    id: "c2-rumors",
    label: "Moving community messages",
    legacy: [LEGACY_RUMOR_DB_NAME],
    perAccount: true,
    run: (self) => migrateLegacyRumors(self!),
  },
  {
    id: "events",
    label: "Moving the event cache",
    legacy: [LEGACY_EVENT_DB_NAME],
    perAccount: false,
    run: () => migrateLegacyEvents(),
  },
  {
    id: "provenance",
    label: "Moving relay provenance",
    legacy: [LEGACY_PROVENANCE_DB_NAME],
    perAccount: false,
    run: () => migrateLegacyProvenance(),
  },
  {
    // Nothing to copy: the parked-wrap store moved to the `c2park` tenant, and
    // its contents are raw wraps the native service re-delivers. Listed so the
    // abandoned database is deleted rather than lingering forever.
    id: "c2-pending",
    label: "Clearing the wrap holding store",
    legacy: ["armada-concord-pending"],
    perAccount: false,
    run: () => Promise.resolve(),
  },
];

/** Set once every migration has run for every account and the old data is gone. */
const COMPLETE_KEY = MIGRATIONS_COMPLETE_KEY;

/** Every legacy database name any migration consumes. */
export function legacyDatabaseNames(): string[] {
  return [...new Set(MIGRATIONS.flatMap((m) => m.legacy))];
}

/**
 * Which legacy databases are still present, i.e. whether there is anything to
 * migrate at all.
 *
 * The completion flag is checked FIRST, ahead of enumerating the origin. It is
 * set only after a run in which every drain succeeded and every database was
 * deleted, so it can't mask unfinished work — and it does mask the one thing
 * enumeration gets wrong: a drain opening a legacy database creates it, so an
 * empty one can exist at an origin that has already migrated (or never had
 * anything to migrate) and would otherwise re-trigger the gate forever.
 *
 * Otherwise enumeration is the direct answer, and the one that self-heals: a
 * database left behind by a half-finished run is found again next launch.
 * Firefox has no `indexedDB.databases()`, so it falls back to assuming the
 * worst — cheap, since the drains no-op once their own flags are set.
 */
export async function pendingLegacyDatabases(): Promise<string[]> {
  const names = legacyDatabaseNames();
  if (typeof indexedDB === "undefined") return [];

  try {
    if (await getArmadaDB().kv.get<boolean>(COMPLETE_KEY)) return [];
  } catch {
    // fall through to enumeration
  }

  if (typeof indexedDB.databases === "function") {
    try {
      const present = new Set(
        (await indexedDB.databases()).flatMap((d) => (d.name ? [d.name] : [])),
      );
      return names.filter((name) => present.has(name));
    } catch {
      // fall through to assuming the worst
    }
  }

  return names;
}

/** Everything the startup gate has to do before the app can read its data. */
export interface PendingUpgrades {
  /** Legacy databases still holding data (see {@link pendingLegacyDatabases}). */
  legacy: string[];
  /** Schema conversions owed for the version on disk. */
  schema: SchemaMigration[];
  /** The data was written by a newer build; nothing will be run against it. */
  future: boolean;
}

/** What {@link runMigrations} would actually do, without doing any of it. */
export async function pendingUpgrades(): Promise<PendingUpgrades> {
  const version = await readSchemaVersion();
  return {
    legacy: await pendingLegacyDatabases(),
    schema: await pendingSchemaMigrations(version),
    future: isFutureVersion(version),
  };
}

/**
 * Record that the data on disk matches this build.
 *
 * Never moves the marker BACKWARDS. A profile stamped by a newer build keeps
 * its stamp: overwriting it with ours would make that build re-run, on its next
 * launch, migrations it already applied.
 */
async function stampCurrentVersion(): Promise<void> {
  const from = await readSchemaVersion();
  if (isFutureVersion(from) || from === ARMADA_DB_VERSION) return;
  await stampSchemaVersion();
}

/**
 * Mark an origin with nothing to migrate as fully up to date.
 *
 * Called by the gate on the quiet path — a fresh install, or any launch after
 * the upgrade — and it is what keeps a fresh install quiet: with the flag set,
 * no drain ever opens (and so never creates) a legacy database, so none is
 * there for the next launch's gate to find.
 */
export async function markUpToDate(): Promise<void> {
  await stampCurrentVersion();
  try {
    await getArmadaDB().kv.set(COMPLETE_KEY, true);
  } catch {
    // best-effort: the drains' own flags still make this idempotent
  }
}

export interface MigrationProgress {
  /** The migration being run. */
  label: string;
  /** How many migration/account pairs have finished. */
  done: number;
  /** How many there are in total. */
  total: number;
}

/**
 * Bring the origin up to {@link ARMADA_DB_VERSION}: drain every legacy database
 * for every account, delete them, apply any schema conversions, and stamp the
 * version.
 *
 * Deletion is the whole reason the drains run across all accounts at once: a
 * per-account drain takes only its own account's share, so the shared database
 * behind it stays live until the last account has been through. A drain that
 * throws leaves its own flag unset and nothing is deleted this round — the next
 * launch retries rather than destroying data nobody copied. That guarantee
 * rests on drains actually REPORTING failure, so a drain must not resolve after
 * swallowing its own error.
 *
 * The schema step is ordered after the drains and gated on them: a conversion
 * is written against the current shape, and data still sitting in a legacy
 * database hasn't reached that shape yet. Running one over a half-migrated
 * origin would convert some rows and miss the rest, then stamp the version so
 * nothing ever revisits them.
 */
export async function runMigrations(
  accounts: string[],
  onProgress?: (progress: MigrationProgress) => void,
): Promise<void> {
  const version = await readSchemaVersion();
  // Written by a newer build. Its shape is not one this code has ever seen, so
  // every conversion here is a guess; leave the data exactly as found.
  if (isFutureVersion(version)) return;

  const schema = await pendingSchemaMigrations(version);
  const jobs = [
    ...MIGRATIONS.flatMap<{ label: string; run: () => Promise<void> }>((m) =>
      m.perAccount
        ? accounts.map((self) => ({ label: m.label, run: () => m.run(self) }))
        : [{ label: m.label, run: () => m.run(undefined) }],
    ),
  ];
  const schemaJobs = schema.map((m) => ({
    to: m.to,
    label: m.label,
    selves: m.perAccount ? accounts : [undefined],
  }));

  const total = jobs.length + schemaJobs.reduce((n, s) => n + s.selves.length, 0);
  let done = 0;
  let failed = false;

  for (const job of jobs) {
    onProgress?.({ label: job.label, done, total });
    try {
      await job.run();
    } catch {
      // Keep going: one subsystem failing shouldn't strand the others. Nothing
      // is deleted this round.
      failed = true;
    }
    done++;
  }

  if (!failed) {
    onProgress?.({ label: "Cleaning up", done, total });
    await deleteLegacyDatabases();
    await getArmadaDB().kv.set(COMPLETE_KEY, true);
  }

  // A schema conversion assumes the drains landed, so a failed drain stops the
  // version advancing too — otherwise the stamp would declare data converted
  // that is still sitting in a database the next launch has yet to drain.
  if (failed) return;

  for (const [i, step] of schemaJobs.entries()) {
    const m = schema[i];
    for (const self of step.selves) {
      onProgress?.({ label: step.label, done, total });
      try {
        await m.run(self);
      } catch {
        // Stop at the first failure: versions are applied in order, and
        // skipping one to run the next hands it data in a shape it was never
        // written for. The version isn't stamped, so the next launch retries.
        return;
      }
      done++;
    }
    // Stamped once the step has run for EVERY account, and per step rather than
    // once at the end, so a run interrupted half way down the list resumes at
    // the next step instead of starting over.
    await stampSchemaVersion(step.to);
  }

  await stampCurrentVersion();
}

/** Delete every consumed database, best-effort. */
async function deleteLegacyDatabases(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await Promise.all(
    legacyDatabaseNames().map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          // `onblocked` fires when a connection is still open; the database is
          // then deleted whenever it closes, so resolving is honest either way.
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        }),
    ),
  );
}

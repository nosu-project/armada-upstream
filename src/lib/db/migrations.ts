/**
 * Catalogue of forward-migrations draining the pre-ArmadaDB IndexedDB
 * databases (irreplaceable data: decrypted messages, invites, decrypt cache).
 * Drains are idempotent and memoised. Triggered by {@link DBMigrationGate} at
 * startup for all accounts (the only path that may DELETE old DBs), and lazily
 * by owning modules' read paths.
 */
import { migrateLegacyInvites } from "@/concord/lib/inviteInbox";
import { DECRYPT_CACHE_DB_NAME } from "@/lib/AppSigner";
import { LEGACY_RUMOR_DB_NAME, migrateLegacyRumors } from "@/concord/lib/rumorMigration";
import { migrateLegacyDms } from "@/lib/nip17/dm17Store";
import { migrateLegacyDecryptCache } from "@/lib/decryptCacheMigration";
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
  /** Stable id (appears in no storage key). */
  id: string;
  label: string;
  /** Legacy databases this drain reads. Deleted once every account is done. */
  legacy: string[];
  /** Per-account drains share one global DB, deletable only after EVERY account drained. */
  perAccount: boolean;
  run(self: string | undefined): Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    // First: the `c2-rumors` drain reads folds (not load-bearing; `readFolded` awaits this drain).
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
    // Nothing to copy (NIP-29 provenance is now the per-relay tenant id); listed
    // so the DB is deleted. `legacy` is the ON-DISK name — don't respell it.
    id: "provenance",
    label: "Clearing relay provenance",
    legacy: ["armada-relay-provenance"],
    perAccount: false,
    run: () => Promise.resolve(),
  },
  {
    // Nothing to copy (native service re-delivers wraps); listed so the DB is deleted.
    id: "c2-pending",
    label: "Clearing the wrap holding store",
    legacy: ["armada-concord-pending"],
    perAccount: false,
    run: () => Promise.resolve(),
  },
];

const COMPLETE_KEY = MIGRATIONS_COMPLETE_KEY;

export function legacyDatabaseNames(): string[] {
  return [...new Set(MIGRATIONS.flatMap((m) => m.legacy))];
}

/**
 * Legacy databases still present. The completion flag is checked first: drains
 * create the DBs they open, so enumeration alone could re-trigger the gate
 * forever. Firefox (no `indexedDB.databases()`) assumes all are present.
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

/** Stamp the current version, never moving a newer build's stamp backwards. */
async function stampCurrentVersion(): Promise<void> {
  const from = await readSchemaVersion();
  if (isFutureVersion(from) || from === ARMADA_DB_VERSION) return;
  await stampSchemaVersion();
}

/**
 * Mark an origin with nothing to migrate as up to date, so drains never open
 * (and create) legacy DBs on later launches.
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
  label: string;
  done: number;
  total: number;
}

/**
 * Bring the origin up to {@link ARMADA_DB_VERSION}: drain every legacy DB for
 * every account, delete them, apply schema conversions, stamp the version.
 * Any drain failure deletes nothing this round (drains MUST report failure,
 * never swallow it). Schema steps run only after all drains succeed, since
 * conversions assume the current shape.
 */
export async function runMigrations(
  accounts: string[],
  onProgress?: (progress: MigrationProgress) => void,
): Promise<void> {
  const version = await readSchemaVersion();
  // Written by a newer build: leave the data exactly as found.
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
    migration: m,
    selves: m.perAccount ? accounts : [undefined as string | undefined],
  }));

  const total = jobs.length + schemaJobs.reduce((n, s) => n + s.selves.length, 0);
  let done = 0;
  let failed = false;

  for (const job of jobs) {
    onProgress?.({ label: job.label, done, total });
    try {
      await job.run();
    } catch {
      // Keep going; nothing is deleted this round.
      failed = true;
    }
    done++;
  }

  if (!failed) {
    onProgress?.({ label: "Cleaning up", done, total });
    await deleteLegacyDatabases();
    await getArmadaDB().kv.set(COMPLETE_KEY, true);
  }

  // A failed drain also stops the version advancing.
  if (failed) return;

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

async function deleteLegacyDatabases(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await Promise.all(
    legacyDatabaseNames().map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          // `onblocked`: deleted once the connection closes.
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        }),
    ),
  );
}

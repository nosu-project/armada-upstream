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
import { migrateLegacyRumors } from "@/concord-v2/lib/rumorMigration";
import { LEGACY_RUMOR_DB_NAME } from "@/concord-v2/lib/rumorStore";
import { migrateLegacyDms } from "@/lib/nip17/dm17Store";
import { migrateLegacyDecryptCache } from "@/lib/decryptCacheMigration";

import { getArmadaDB } from "./armadaDB";

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
const COMPLETE_KEY = "migrations:complete";

/** Every legacy database name any migration consumes. */
export function legacyDatabaseNames(): string[] {
  return [...new Set(MIGRATIONS.flatMap((m) => m.legacy))];
}

/**
 * Which legacy databases are still present, i.e. whether there is anything to
 * migrate at all.
 *
 * Enumerating the origin is the direct answer, and the one that self-heals: a
 * database left behind by a half-finished run is found again next launch.
 * Firefox has no `indexedDB.databases()`, so it falls back to a KV flag — and
 * when even that is unset, to assuming the worst. Assuming the worst is cheap:
 * the drains no-op once their own flags are set.
 */
export async function pendingLegacyDatabases(): Promise<string[]> {
  const names = legacyDatabaseNames();
  if (typeof indexedDB === "undefined") return [];

  if (typeof indexedDB.databases === "function") {
    try {
      const present = new Set(
        (await indexedDB.databases()).flatMap((d) => (d.name ? [d.name] : [])),
      );
      return names.filter((name) => present.has(name));
    } catch {
      // fall through to the flag
    }
  }

  return (await getArmadaDB().kv.get<boolean>(COMPLETE_KEY)) ? [] : names;
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
 * Run every migration for every account, then delete the databases they
 * consumed.
 *
 * Deletion is the whole reason this runs across all accounts at once: a
 * per-account drain takes only its own account's share, so the shared database
 * behind it stays live until the last account has been through. A drain that
 * throws leaves its own flag unset and this returns early WITHOUT deleting —
 * the next launch retries rather than destroying data nobody copied.
 */
export async function runMigrations(
  accounts: string[],
  onProgress?: (progress: MigrationProgress) => void,
): Promise<void> {
  const jobs = MIGRATIONS.flatMap<{ m: Migration; self: string | undefined }>((m) =>
    m.perAccount ? accounts.map((self) => ({ m, self })) : [{ m, self: undefined }],
  );

  let done = 0;
  let failed = false;
  for (const { m, self } of jobs) {
    onProgress?.({ label: m.label, done, total: jobs.length });
    try {
      await m.run(self);
    } catch {
      // Keep going: one subsystem failing shouldn't strand the others. Nothing
      // is deleted this round.
      failed = true;
    }
    done++;
  }
  onProgress?.({ label: "Cleaning up", done, total: jobs.length });

  if (failed) return;
  await deleteLegacyDatabases();
  await getArmadaDB().kv.set(COMPLETE_KEY, true);
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

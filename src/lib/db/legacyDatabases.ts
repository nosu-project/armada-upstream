/**
 * The IndexedDB databases Armada kept before ArmadaDB, named here only so the
 * bytes can be deleted.
 *
 * Nothing reads them. ArmadaDB is a clean break: a build older than it wrote
 * its own per-subsystem databases, and that data stays in that build rather
 * than being copied forward. What is NOT acceptable is leaving them on disk —
 * several hold decrypted messages, and an abandoned database is never swept by
 * anything else — so this list outlives the code that wrote them.
 */

/** Every pre-ArmadaDB database name. */
export const LEGACY_DATABASE_NAMES = [
  /** The Concord fold cache. */
  "armada-concord-cache",
  /** The signer's NIP-44 decrypt cache. */
  "armada-decrypt-cache",
  /** Concord invite inbox. */
  "armada-concord-invites",
  /** Opened NIP-17 DM rumors. */
  "armada-dm17-rumors",
  /** Opened Concord V2 rumors. */
  "armada-concord-rumors",
  /** Parked Concord V2 wraps. */
  "armada-concord-pending",
  /** The shared signed-event cache. */
  "armada-events",
  /** Per-event relay provenance. */
  "armada-relay-provenance",
];

/**
 * Delete every pre-ArmadaDB database, best-effort.
 *
 * Fire-and-forget at startup: a `deleteDatabase` for a name that was never
 * created is a no-op (it does NOT create one), and one that is still open
 * somewhere resolves `onblocked` and is deleted when that connection closes.
 */
export async function deleteLegacyDatabases(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await Promise.all(
    LEGACY_DATABASE_NAMES.map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
}

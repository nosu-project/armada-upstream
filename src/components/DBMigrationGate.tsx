import { useEffect, useRef, useState } from "react";
import { useNostrLogin } from "@nostrify/react/login";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { TerminalProgress } from "@/components/brand/TerminalProgress";
import { markUpToDate, pendingUpgrades, runMigrations } from "@/lib/db/migrations";

import type { SyncLogLine } from "@/hooks/useInitialSync";

/**
 * Full-screen storage-upgrade overlay.
 *
 * Runs two kinds of upgrade, in this order:
 *
 *  - **Legacy drains.** Armada's per-subsystem IndexedDB databases were folded
 *    into ArmadaDB. The data in them can't be dropped — decrypted messages,
 *    invites the sync cursor has passed, a decrypt cache worth a bunker prompt
 *    per entry — so it is copied forward, and the old databases are deleted
 *    only once every logged-in account has taken its share out.
 *  - **Schema migrations.** Conversions between ArmadaDB data versions, for
 *    everything that changes after the fold (see `db/schema.ts`).
 *
 * This is the only place that can do the deletion, because it is the only
 * place that runs the per-account drains for ALL accounts at once. The owning
 * modules also drain lazily on their own read paths, which covers an account
 * that logs in later; that path can copy but never delete.
 *
 * Renders nothing when the data on disk already matches this build, which is
 * every launch after the first — so the overlay is a once-per-upgrade event,
 * not a startup cost. Deliberately mirrors {@link SyncGate}: crest, wordmark,
 * and a terminal progress list, so an upgrade looks like the sync the user
 * already knows.
 */
export function DBMigrationGate() {
  const { logins } = useNostrLogin();
  const [active, setActive] = useState(false);
  const [log, setLog] = useState<SyncLogLine[]>([]);
  const started = useRef(false);

  // The account list is read once, when the run starts: a login that arrives
  // mid-migration would otherwise restart it, and it is covered by the lazy
  // drain on its own first read anyway.
  const accounts = logins.map((l) => l.pubkey);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    void (async () => {
      const pending = await pendingUpgrades().catch(() => null);
      if (cancelled || !pending) return;

      // Data written by a newer build. Nothing here can convert a shape that
      // didn't exist when it was written, and stamping would move the version
      // marker backwards, so the whole gate stands down.
      if (pending.future) return;

      if (pending.legacy.length === 0 && pending.schema.length === 0) {
        // Nothing to do — a fresh install, or any launch after the upgrade.
        // Stamping is not bookkeeping for its own sake: the completion flag is
        // what stops the drains ever opening a legacy database, and opening one
        // CREATES it, which would put this gate back on screen next launch.
        await markUpToDate().catch(() => undefined);
        return;
      }

      setActive(true);
      setLog([{ id: "open", text: "upgrading local storage", tone: "info" }]);

      await runMigrations(accountsRef.current, ({ label, done, total }) => {
        if (cancelled) return;
        setLog((prev) => [
          // Resolve whatever was running; only the newest line is in flight.
          ...prev.map((l) => (l.status === undefined ? { ...l, status: "OK", tone: "ok" as const } : l)),
          { id: `${label}:${done}`, text: label.toLowerCase(), status: `${done}/${total}` },
        ]);
      });

      if (cancelled) return;
      setLog((prev) => [
        ...prev.map((l) => (l.status === undefined ? { ...l, status: "OK", tone: "ok" as const } : l)),
        { id: "done", text: "storage upgraded", status: "OK", tone: "ok" },
      ]);
      // Hold a beat so the final line lands before the overlay clears.
      setTimeout(() => {
        if (!cancelled) setActive(false);
      }, 500);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-10 bg-background px-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-6">
        <ArmadaCrest size={96} loop />
        <BrandMark />
      </div>

      <TerminalProgress lines={log} />

      <ArmadaCrestKeyframes />
    </div>
  );
}

export default DBMigrationGate;

import { useEffect, useRef, useState } from "react";
import { useNostrLogin } from "@nostrify/react/login";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { BrandMark } from "@/components/brand/BrandMark";
import { TerminalProgress } from "@/components/brand/TerminalProgress";
import { markUpToDate, pendingUpgrades, runMigrations } from "@/lib/db/migrations";

import type { SyncLogLine } from "@/hooks/useInitialSync";

/**
 * Full-screen storage-upgrade overlay. Runs legacy drains (old per-subsystem
 * IndexedDBs copied into ArmadaDB, deleted once every logged-in account has
 * drained) then schema migrations (see `db/schema.ts`).
 *
 * Only this can delete legacy DBs since it's the only place draining ALL
 * accounts; lazy per-module drains copy but never delete. Renders nothing when
 * on-disk data already matches this build.
 */
export function DBMigrationGate() {
  const { logins } = useNostrLogin();
  const [active, setActive] = useState(false);
  const [log, setLog] = useState<SyncLogLine[]>([]);
  const started = useRef(false);

  // Accounts read once: a mid-migration login would otherwise restart the run;
  // the lazy drain covers it.
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

      // Data written by a newer build: can't convert it, and stamping would move the
      // version marker backwards.
      if (pending.future) return;

      if (pending.legacy.length === 0 && pending.schema.length === 0) {
        // Stamping matters: the completion flag stops drains from opening (and thereby
        // CREATING) a legacy DB, which would bring this gate back next launch.
        await markUpToDate().catch(() => undefined);
        return;
      }

      setActive(true);
      setLog([{ id: "open", text: "upgrading local storage", tone: "info" }]);

      await runMigrations(accountsRef.current, ({ label, done, total }) => {
        if (cancelled) return;
        setLog((prev) => [
          ...prev.map((l) => (l.status === undefined ? { ...l, status: "OK", tone: "ok" as const } : l)),
          { id: `${label}:${done}`, text: label.toLowerCase(), status: `${done}/${total}` },
        ]);
      });

      if (cancelled) return;
      setLog((prev) => [
        ...prev.map((l) => (l.status === undefined ? { ...l, status: "OK", tone: "ok" as const } : l)),
        { id: "done", text: "storage upgraded", status: "OK", tone: "ok" },
      ]);
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

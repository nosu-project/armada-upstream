import { useEffect, useState } from "react";

import { BackupKeyDialog } from "@/components/auth/BackupKeyDialog";
import { useActiveNsec } from "@/hooks/useActiveNsec";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import { snoozeKeyBackupReminder, useKeyBackupRemindAt } from "@/lib/keyBackup";

/**
 * Asks a signup-minted account to back up its key once the reminder is due
 * (see `lib/keyBackup.ts`), never over onboarding. Any dismissal snoozes it.
 */
export function KeyBackupReminder() {
  const active = useActiveNsec();
  const onboarding = useOnboardingActive();
  const remindAt = useKeyBackupRemindAt(active?.pubkey);
  const [due, setDue] = useState(false);

  useEffect(() => {
    setDue(false);
    if (remindAt === null) return;
    const wait = remindAt - Date.now();
    if (wait <= 0) {
      setDue(true);
      return;
    }
    // setTimeout overflows past ~24.8 days.
    const timer = setTimeout(() => setDue(true), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [remindAt]);

  if (!active) return null;

  return (
    <BackupKeyDialog
      open={due && remindAt !== null && !onboarding}
      onOpenChange={(open) => {
        if (!open) snoozeKeyBackupReminder(active.pubkey);
      }}
      nsec={active.nsec}
      pubkey={active.pubkey}
    />
  );
}

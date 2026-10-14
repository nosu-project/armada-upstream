// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  KEY_BACKUP_FIRST_REMINDER_MS,
  KEY_BACKUP_SNOOZE_MS,
  clearKeyBackupPending,
  keyBackupPending,
  keyBackupRemindAt,
  markKeyBackupPending,
  snoozeKeyBackupReminder,
} from "@/lib/keyBackup";

const ana = "a".repeat(64);
const ben = "b".repeat(64);

beforeEach(() => localStorage.clear());

describe("keyBackup", () => {
  it("is not pending for an account signup didn't mint", () => {
    expect(keyBackupPending(ana)).toBe(false);
    expect(keyBackupRemindAt(ana)).toBeNull();
  });

  it("holds the first reminder back so onboarding isn't interrupted", () => {
    markKeyBackupPending(ana, 1000);
    expect(keyBackupRemindAt(ana)).toBe(1000 + KEY_BACKUP_FIRST_REMINDER_MS);
    expect(keyBackupPending(ben)).toBe(false);
  });

  it("snoozes a pending reminder and ignores an account that has none", () => {
    markKeyBackupPending(ana, 0);
    snoozeKeyBackupReminder(ana, 5000);
    expect(keyBackupRemindAt(ana)).toBe(5000 + KEY_BACKUP_SNOOZE_MS);

    snoozeKeyBackupReminder(ben, 5000);
    expect(keyBackupPending(ben)).toBe(false);
  });

  it("clears once backed up", () => {
    markKeyBackupPending(ana);
    clearKeyBackupPending(ana);
    expect(keyBackupPending(ana)).toBe(false);
  });

  it("treats an unreadable marker as due now rather than never", () => {
    localStorage.setItem(`armada:key-backup-pending:${ana}`, "garbage");
    expect(keyBackupRemindAt(ana)).toBe(0);
    localStorage.setItem(`armada:key-backup-pending:${ana}`, "{}");
    expect(keyBackupRemindAt(ana)).toBe(0);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sk = generateSecretKey();
const nsec = nip19.nsecEncode(sk);
const pubkey = getPublicKey(sk);

const h = vi.hoisted(() => ({ onboarding: false }));

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey } }) }));
vi.mock("@nostrify/react/login", () => ({
  useNostrLogin: () => ({ logins: [{ type: "nsec", pubkey, data: { nsec } }] }),
}));
vi.mock("@/hooks/useOnboarding", () => ({ useOnboardingActive: () => h.onboarding }));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

import { KeyBackupReminder } from "@/components/auth/KeyBackupReminder";
import { KEY_BACKUP_FIRST_REMINDER_MS, keyBackupRemindAt, markKeyBackupPending } from "@/lib/keyBackup";

const TITLE = "back up your secret key";

beforeEach(() => {
  localStorage.clear();
  h.onboarding = false;
});

describe("KeyBackupReminder", () => {
  it("stays quiet for an account with nothing to back up", () => {
    render(<KeyBackupReminder />);
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("waits out the first hour after signup", () => {
    markKeyBackupPending(pubkey);
    render(<KeyBackupReminder />);
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("asks once due, and Later snoozes it", () => {
    markKeyBackupPending(pubkey, Date.now() - KEY_BACKUP_FIRST_REMINDER_MS);
    render(<KeyBackupReminder />);
    expect(screen.getByText(TITLE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(keyBackupRemindAt(pubkey)).toBeGreaterThan(Date.now());
  });

  it("never opens over onboarding", () => {
    h.onboarding = true;
    markKeyBackupPending(pubkey, Date.now() - KEY_BACKUP_FIRST_REMINDER_MS);
    render(<KeyBackupReminder />);
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});

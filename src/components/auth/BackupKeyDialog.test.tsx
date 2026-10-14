import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  backUpNsec: vi.fn(),
  writeClipboardText: vi.fn(async (_text: string) => {}),
}));

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: h.writeClipboardText }));
vi.mock("@/lib/credentialManager", () => ({ backUpNsec: h.backUpNsec }));

import { BackupKeyDialog } from "@/components/auth/BackupKeyDialog";
import { keyBackupPending, markKeyBackupPending } from "@/lib/keyBackup";

const sk = generateSecretKey();
const nsec = nip19.nsecEncode(sk);
const pubkey = getPublicKey(sk);

beforeEach(() => {
  localStorage.clear();
  h.backUpNsec.mockReset();
  h.writeClipboardText.mockClear();
  markKeyBackupPending(pubkey);
});

describe("BackupKeyDialog", () => {
  it("clears the pending backup once the key is copied", async () => {
    const onOpenChange = vi.fn();
    render(<BackupKeyDialog open onOpenChange={onOpenChange} nsec={nsec} pubkey={pubkey} />);

    fireEvent.click(screen.getByRole("button", { name: "Show key" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));

    await waitFor(() => expect(keyBackupPending(pubkey)).toBe(false));
    expect(h.writeClipboardText).toHaveBeenCalledWith(nsec);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the backup pending when the save is cancelled", async () => {
    h.backUpNsec.mockResolvedValue({ status: "cancelled" });
    render(<BackupKeyDialog open onOpenChange={vi.fn()} nsec={nsec} pubkey={pubkey} />);

    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(h.backUpNsec).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Save key" })).not.toBeDisabled());
    expect(keyBackupPending(pubkey)).toBe(true);
  });

  it("stands between logout and an account with no backup", async () => {
    h.backUpNsec.mockResolvedValue({ status: "saved", location: "your downloads" });
    const onLogout = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <BackupKeyDialog open onOpenChange={onOpenChange} nsec={nsec} pubkey={pubkey} onLogout={onLogout} />,
    );

    expect(screen.getByText("back up before logging out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out anyway" })).toBeInTheDocument();

    // Backing up keeps the dialog open so the user can finish logging out.
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(keyBackupPending(pubkey)).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

/**
 * The page signup wizard logs in with a freshly minted key as soon as it opens.
 * `createAccount` seeds that account's scoped config with its home relays
 * (`useSignupLists`) and then advances, on the assumption that the login it just
 * requested is now the active one. Advancing before the login is durable leaves
 * the wizard rendering nothing (the profile step requires `user`), and a
 * rejected persist needs a way to retry.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  nsec: vi.fn<(key: string) => Promise<void>>(),
  toast: vi.fn(),
  seed: vi.fn(),
  publish: vi.fn(),
  navigate: vi.fn(),
  markKeyBackupPending: vi.fn<(pubkey: string) => void>(),
  clearKeyBackupPending: vi.fn<(pubkey: string) => void>(),
  user: undefined as { pubkey: string } | undefined,
}));

vi.mock("@/hooks/useSignupLists", () => ({ useSignupLists: () => ({ seed: h.seed, publish: h.publish }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => h.navigate }));
vi.mock("@/components/onboarding/WizardShell", () => ({
  WizardShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/onboarding/ProfileStep", () => ({
  ProfileStepBody: ({ onFinish }: { onFinish: () => void }) => (
    <>
      <div>set up your profile</div>
      <button onClick={onFinish}>Skip for now</button>
    </>
  ),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      appRelays: ["wss://home.example/"],
      searchRelays: ["wss://search.example"],
      communityRelays: [],
      broadcastRelays: [],
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useLoginActions", () => ({
  useLoginActions: () => ({ nsec: h.nsec }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/hooks/useFreshLogin", () => ({ suppressNextSyncGate: vi.fn() }));
vi.mock("@/hooks/useOnboarding", () => ({ setOnboardingActive: vi.fn() }));
vi.mock("@/lib/relayRecoveryPrompt", () => ({ markRelayRecoveryPromptShown: vi.fn() }));
vi.mock("@/lib/joinLink", () => ({
  peekPendingJoin: () => undefined,
  clearPendingJoin: vi.fn(),
}));
vi.mock("@/lib/keyBackup", () => ({
  markKeyBackupPending: h.markKeyBackupPending,
  clearKeyBackupPending: h.clearKeyBackupPending,
}));

import { SignupWizard } from "@/pages/SignupWizard";

beforeEach(() => {
  h.nsec.mockReset();
  h.toast.mockReset();
  h.seed.mockReset();
  h.publish.mockReset();
  h.navigate.mockReset();
  h.markKeyBackupPending.mockReset();
  h.clearKeyBackupPending.mockReset();
  h.user = undefined;
});

describe("SignupWizard account creation", () => {
  it("signs in with the minted key at once and stays put until the login persists", async () => {
    let settle!: () => void;
    h.nsec.mockImplementation(
      () => new Promise<void>((resolve) => { settle = resolve; }),
    );

    render(<SignupWizard onExit={vi.fn()} />);
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));

    // The profile step only renders once `user` exists, so leaving early would
    // blank the screen while the login is still in flight.
    expect(screen.getByText("creating your account…")).toBeInTheDocument();

    settle();
    await waitFor(() => expect(screen.queryByText("creating your account…")).toBeNull());
  });

  it("marks the key as awaiting a backup before the login", async () => {
    h.nsec.mockResolvedValue(undefined);
    render(<SignupWizard onExit={vi.fn()} />);
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));

    const pubkey = getPublicKey(nip19.decode(h.nsec.mock.calls[0][0]).data as Uint8Array);
    expect(h.markKeyBackupPending).toHaveBeenCalledWith(pubkey);
    // Adding an account reloads the app, so the marker must already be written.
    expect(h.markKeyBackupPending.mock.invocationCallOrder[0])
      .toBeLessThan(h.nsec.mock.invocationCallOrder[0]);
  });

  it("offers a retry with the same key when the login cannot be persisted", async () => {
    h.nsec.mockRejectedValueOnce(new Error("secure storage unavailable"));

    render(<SignupWizard onExit={vi.fn()} />);
    await screen.findByText("couldn't create your account");
    // A key no account uses isn't awaiting a backup.
    expect(h.clearKeyBackupPending).toHaveBeenCalled();

    h.nsec.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(2));
    expect(h.nsec.mock.calls[1][0]).toBe(h.nsec.mock.calls[0][0]);
  });

  it("publishes the default lists and exits onto Discover once the profile step finishes", async () => {
    h.nsec.mockImplementation(async () => {
      h.user = { pubkey: "a".repeat(64) };
    });
    render(<SignupWizard onExit={vi.fn()} />);
    // Home relays are seeded before login, so the profile publishes there.
    await screen.findByText("set up your profile");
    expect(h.seed).toHaveBeenCalledWith(expect.any(String), ["wss://home.example"]);
    expect(h.publish).not.toHaveBeenCalled();

    // The profile is the last step: no relay screen follows.
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(h.publish).toHaveBeenCalledWith(
      h.nsec.mock.calls[0][0],
      expect.objectContaining({
        home: ["wss://home.example"],
        search: ["wss://search.example"],
      }),
      undefined,
    );
    expect(h.navigate).toHaveBeenCalledWith("/discover");
  });
});

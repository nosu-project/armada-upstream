/**
 * `SignupDialog` is the in-app account-creation flow (reached from the
 * "Create account" escape hatch in `LoginScreen`, opened by `JoinButton`,
 * `LoginArea` and `GroupChat`). It mirrors the landing wizard: sign in with a
 * freshly minted key at once, then a profile step — and it applies the same fresh-account
 * suppressions and onboarding flag so the post-login setup flow (`LoginSetup`,
 * including its "restore your setup" relay step, which is external-login
 * recovery UI) never fires over a brand-new signup.
 *
 * `login.nsec` is asynchronous (adding an account while one is active is a full
 * switch: persist → hard reload). Advancing to the profile step before the
 * login is durable would render a step that requires `user`, and a rejected
 * persist would have no handler at all.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  nsec: vi.fn<(key: string) => Promise<void>>(),
  suppressNextSyncGate: vi.fn<(pubkey: string) => void>(),
  markRelayRecoveryPromptShown: vi.fn<(pubkey: string) => void>(),
  markNotificationSettingsReady: vi.fn<(pubkey: string) => void>(),
  setOnboardingActive: vi.fn<(next: boolean) => void>(),
  seed: vi.fn<(pubkey: string, homeRelays: string[]) => void>(),
  publish: vi.fn(),
  markKeyBackupPending: vi.fn<(pubkey: string) => void>(),
  clearKeyBackupPending: vi.fn<(pubkey: string) => void>(),
  user: undefined as { pubkey: string } | undefined,
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
vi.mock("@/hooks/useSignupLists", () => ({
  useSignupLists: () => ({ seed: h.seed, publish: h.publish }),
}));
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
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useLoginActions", () => ({
  useLoginActions: () => ({ nsec: h.nsec }),
}));
vi.mock("@/hooks/useFreshLogin", () => ({
  suppressNextSyncGate: h.suppressNextSyncGate,
}));
vi.mock("@/hooks/useOnboarding", () => ({
  setOnboardingActive: h.setOnboardingActive,
}));
vi.mock("@/lib/relayRecoveryPrompt", () => ({
  markRelayRecoveryPromptShown: h.markRelayRecoveryPromptShown,
}));
vi.mock("@/lib/notificationSettingsAuthority", () => ({
  markNotificationSettingsReady: h.markNotificationSettingsReady,
}));
vi.mock("@/lib/keyBackup", () => ({
  markKeyBackupPending: h.markKeyBackupPending,
  clearKeyBackupPending: h.clearKeyBackupPending,
}));

import SignupDialog from "@/components/auth/SignupDialog";

beforeEach(() => {
  h.nsec.mockReset();
  h.suppressNextSyncGate.mockReset();
  h.markRelayRecoveryPromptShown.mockReset();
  h.markNotificationSettingsReady.mockReset();
  h.setOnboardingActive.mockReset();
  h.seed.mockReset();
  h.publish.mockReset();
  h.markKeyBackupPending.mockReset();
  h.clearKeyBackupPending.mockReset();
  h.user = undefined;
});

describe("SignupDialog account creation", () => {
  it("does nothing while closed", async () => {
    render(<SignupDialog isOpen={false} onClose={vi.fn()} onComplete={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.nsec).not.toHaveBeenCalled();
  });

  it("advances to the profile step only after the login has been persisted", async () => {
    let settle!: () => void;
    h.nsec.mockImplementation(
      () => new Promise<void>((resolve) => { settle = resolve; }),
    );
    const onClose = vi.fn();
    const onComplete = vi.fn();

    render(<SignupDialog isOpen onClose={onClose} onComplete={onComplete} />);
    // Opening is the request: there is no key step to click through.
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));

    // The login is still in flight: the profile step renders on `user`, so
    // advancing before the login commits would blank the flow. It stays on the
    // creating screen, and does not report itself finished.
    expect(screen.getByText("creating your account…")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The login commits and exposes the user; the flow moves to the profile
    // step — still without dismissing.
    h.user = { pubkey: getPublicKey(nip19.decode(h.nsec.mock.calls[0][0]).data as Uint8Array) };
    settle();
    await waitFor(() => expect(screen.getByText("set up your profile")).toBeInTheDocument());
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("publishes the default lists, dismisses and reports complete when the profile step finishes", async () => {
    h.nsec.mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onComplete = vi.fn();

    h.user = { pubkey: "a".repeat(64) };
    render(<SignupDialog isOpen onClose={onClose} onComplete={onComplete} />);
    await screen.findByText("set up your profile");
    expect(onComplete).not.toHaveBeenCalled();

    // The profile is the last step: finishing it publishes the default lists,
    // ends onboarding, hands back to the caller, and dismisses.
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(h.publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ home: ["wss://home.example"] }),
      undefined,
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.setOnboardingActive).toHaveBeenLastCalledWith(false);
  });

  it("offers a retry when the login could not be persisted", async () => {
    // `addAndSwitchAccount` rejects when the durable login list cannot be
    // written. Advancing anyway would strand the user on a blank profile step
    // for an account that does not exist.
    h.nsec.mockRejectedValueOnce(new Error("secure storage unavailable"));
    const onClose = vi.fn();
    const onComplete = vi.fn();

    render(<SignupDialog isOpen onClose={onClose} onComplete={onComplete} />);
    await screen.findByText("couldn't create your account");

    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // A failed login lowers the flag it raised, so nothing else is suppressed
    // by a signup that never completed, and its unused key awaits no backup.
    expect(h.setOnboardingActive).toHaveBeenLastCalledWith(false);
    expect(h.clearKeyBackupPending).toHaveBeenCalled();

    h.nsec.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(2));
    expect(h.nsec.mock.calls[1][0]).toBe(h.nsec.mock.calls[0][0]);
  });

  it("opts the brand-new key out of the sync gate and the recovery prompt", async () => {
    // A freshly minted key has nothing on any relay: it must not raise the
    // post-login sync gate, and must never reach LoginSetup's "restore your
    // setup" step (external-login recovery UI). Both are opted out by pubkey
    // before the login is requested — the same two suppressions the landing
    // wizard applies. Without them a signup from this dialog lands straight in
    // the relay-list recovery step with no username prompt.
    h.nsec.mockResolvedValue(undefined);

    render(<SignupDialog isOpen onClose={vi.fn()} onComplete={vi.fn()} />);
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));

    // The suppressions must name the account being created — the pubkey of the
    // very nsec handed to login.nsec, not some other key.
    const nsecArg = h.nsec.mock.calls[0][0];
    const pubkey = getPublicKey(nip19.decode(nsecArg).data as Uint8Array);
    expect(h.suppressNextSyncGate).toHaveBeenCalledWith(pubkey);
    expect(h.markRelayRecoveryPromptShown).toHaveBeenCalledWith(pubkey);
    // A minted key has no notifications document: its defaults are the policy.
    expect(h.markNotificationSettingsReady).toHaveBeenCalledWith(pubkey);
    // Its only copy is on this device until the user backs it up.
    expect(h.markKeyBackupPending).toHaveBeenCalledWith(pubkey);
    // The onboarding flag is raised before login so LoginSetup can't paint over
    // the profile step.
    expect(h.setOnboardingActive).toHaveBeenCalledWith(true);
    // Home relays are seeded before login; the lists wait for the end.
    expect(h.seed).toHaveBeenCalledWith(pubkey, ["wss://home.example"]);
    expect(h.seed.mock.invocationCallOrder[0])
      .toBeLessThan(h.nsec.mock.invocationCallOrder[0]);
    expect(h.publish).not.toHaveBeenCalled();
  });
});

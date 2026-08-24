/**
 * `SignupDialog` is the in-app account-creation flow (reached from the
 * "Create account" escape hatch in `LoginScreen`, opened by `JoinButton`,
 * `LoginArea` and `GroupChat`). It now mirrors the landing wizard: generate a
 * key, save it, then a profile step — and it applies the same fresh-account
 * suppressions and onboarding flag so the post-login setup flow (`LoginSetup`,
 * including its "restore your setup" relay step, which is external-login
 * recovery UI) never fires over a brand-new signup.
 *
 * `login.nsec` is asynchronous (adding an account while one is active is a full
 * switch: persist → hard reload). Advancing to the profile step before the
 * login is durable would render a step that requires `user`, and a rejected
 * persist would have no handler at all — for a key whose only copy the user was
 * just told to back up.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  nsec: vi.fn<(key: string) => Promise<void>>(),
  suppressNextSyncGate: vi.fn<(pubkey: string) => void>(),
  markRelayRecoveryPromptShown: vi.fn<(pubkey: string) => void>(),
  setOnboardingActive: vi.fn<(next: boolean) => void>(),
  user: undefined as { pubkey: string } | undefined,
}));

vi.mock("@/components/onboarding/WizardShell", () => ({
  WizardShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ProfileSettings", () => ({
  ProfileSettings: ({ onSaved }: { onSaved?: () => void }) => (
    <button onClick={() => onSaved?.()}>save profile</button>
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
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({
  writeClipboardText: vi.fn(async () => {}),
}));
vi.mock("@/lib/credentialManager", () => ({
  backUpNsec: vi.fn(async () => ({ status: "cancelled" as const })),
}));

import SignupDialog from "@/components/auth/SignupDialog";

/** Walk the wizard to a state where Continue is enabled. */
async function reachEnabledContinue() {
  fireEvent.click(screen.getByRole("button", { name: "Generate my key" }));
  fireEvent.click(await screen.findByRole("button", { name: /Copy key/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled()
  );
}

beforeEach(() => {
  h.nsec.mockReset();
  h.suppressNextSyncGate.mockReset();
  h.markRelayRecoveryPromptShown.mockReset();
  h.setOnboardingActive.mockReset();
  h.user = undefined;
});

describe("SignupDialog account creation", () => {
  it("advances to the profile step only after the login has been persisted", async () => {
    let settle!: () => void;
    h.nsec.mockImplementation(
      () => new Promise<void>((resolve) => { settle = resolve; }),
    );
    const onClose = vi.fn();
    const onComplete = vi.fn();

    render(<SignupDialog isOpen onClose={onClose} onComplete={onComplete} />);
    await reachEnabledContinue();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));

    // The login is still in flight: the profile step renders on `user`, so
    // advancing before the login commits would blank the flow. It stays on the
    // save step, and does not report itself finished.
    expect(screen.getByText("save your secret key")).toBeInTheDocument();
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

  it("dismisses and reports complete when the profile step finishes", async () => {
    h.nsec.mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onComplete = vi.fn();

    render(<SignupDialog isOpen onClose={onClose} onComplete={onComplete} />);
    await reachEnabledContinue();

    h.user = { pubkey: "a".repeat(64) };
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("set up your profile");

    // Skipping the profile step ends onboarding, hands back to the caller, and
    // dismisses — and lowers the onboarding flag it raised at login.
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.setOnboardingActive).toHaveBeenLastCalledWith(false);
  });

  it("does not advance when the login could not be persisted", async () => {
    // `addAndSwitchAccount` rejects when the durable login list cannot be
    // written. Advancing anyway would strand the user on a blank profile step
    // for an account that does not exist — and the key it just made them back
    // up is the only copy of one.
    h.nsec.mockRejectedValue(new Error("secure storage unavailable"));
    const onClose = vi.fn();
    const onComplete = vi.fn();

    render(<SignupDialog isOpen onClose={onClose} onComplete={onComplete} />);
    await reachEnabledContinue();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));
    // Give a fire-and-forget call every chance to run its continuation.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByText("save your secret key")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // A failed login lowers the flag it raised, so nothing else is suppressed
    // by a signup that never completed.
    expect(h.setOnboardingActive).toHaveBeenLastCalledWith(false);
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
    await reachEnabledContinue();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));

    // The suppressions must name the account being created — the pubkey of the
    // very nsec handed to login.nsec, not some other key.
    const nsecArg = h.nsec.mock.calls[0][0];
    const pubkey = getPublicKey(nip19.decode(nsecArg).data as Uint8Array);
    expect(h.suppressNextSyncGate).toHaveBeenCalledWith(pubkey);
    expect(h.markRelayRecoveryPromptShown).toHaveBeenCalledWith(pubkey);
    // The onboarding flag is raised before login so LoginSetup can't paint over
    // the profile step.
    expect(h.setOnboardingActive).toHaveBeenCalledWith(true);
  });
});

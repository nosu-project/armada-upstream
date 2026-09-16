/**
 * The page signup wizard's key-save step is the second call site that invokes
 * the now-asynchronous `login.nsec` fire-and-forget.
 *
 * It is the riskier of the two: `handleContinue` stashes a kind-10002 signed
 * with the freshly minted key in `pendingRelayList`, seeds that account's
 * scoped config blob, and then advances the wizard — all on the assumption
 * that the login it just requested is now the active one. Advancing before
 * the login is durable leaves the wizard rendering nothing (the profile step
 * requires `user`), and a rejected persist has no handler at all.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  nsec: vi.fn<(key: string) => Promise<void>>(),
  toast: vi.fn(),
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/onboarding/WizardShell", () => ({
  WizardShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/onboarding/ProfileStep", () => ({
  ProfileStepBody: () => <div>set up your profile</div>,
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://home.example/"] } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useLoginActions", () => ({
  useLoginActions: () => ({ nsec: h.nsec }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/hooks/useFreshLogin", () => ({ suppressNextSyncGate: vi.fn() }));
vi.mock("@/hooks/useOnboarding", () => ({ setOnboardingActive: vi.fn() }));
vi.mock("@/lib/activeAccount", () => ({
  APP_CONFIG_STORAGE_KEY: "armada:app-config",
  seedAccountConfig: vi.fn(),
}));
vi.mock("@/lib/relayRecoveryPrompt", () => ({ markRelayRecoveryPromptShown: vi.fn() }));
vi.mock("@/lib/joinLink", () => ({
  peekPendingJoin: () => undefined,
  clearPendingJoin: vi.fn(),
}));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: vi.fn(async () => {}) }));
vi.mock("@/lib/credentialManager", () => ({
  backUpNsec: vi.fn(async () => ({ status: "cancelled" as const })),
}));

import { SignupWizard } from "@/pages/SignupWizard";

/**
 * Generate a key and satisfy the backup gate so Continue appears — it is
 * absent rather than disabled until then, and copying is reached by revealing
 * the key, which swaps the eye for a clipboard.
 */
async function reachContinue() {
  fireEvent.click(screen.getByRole("button", { name: "Generate my key" }));
  fireEvent.click(await screen.findByRole("button", { name: "Show key" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
  await screen.findByRole("button", { name: "Continue" });
}

beforeEach(() => {
  h.nsec.mockReset();
  h.toast.mockReset();
});

describe("SignupWizard key-save step", () => {
  it("stays on the key-save step until the login has been persisted", async () => {
    let settle!: () => void;
    h.nsec.mockImplementation(
      () => new Promise<void>((resolve) => { settle = resolve; }),
    );

    render(<SignupWizard onExit={vi.fn()} />);
    await reachContinue();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));

    // The wizard advanced to a step that only renders once `user` exists, so
    // leaving early is not merely premature — it blanks the screen while the
    // login is still in flight.
    expect(screen.getByText("save your secret key")).toBeInTheDocument();

    settle();
    await waitFor(() => expect(screen.queryByText("save your secret key")).toBeNull());
  });

  it("recovers on the key-save step when the login cannot be persisted", async () => {
    h.nsec.mockRejectedValue(new Error("secure storage unavailable"));

    render(<SignupWizard onExit={vi.fn()} />);
    await reachContinue();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));
    // Give a fire-and-forget call every chance to run its continuation.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The user still holds the only copy of a key that no account uses yet.
    // Stranding them on a blank screen with no message is the worst outcome.
    expect(screen.getByText("save your secret key")).toBeInTheDocument();
    // Continue is still there to try again with — the failure is the login's,
    // not the backup's, and the backup is what puts the button on screen.
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(h.toast).toHaveBeenCalled();
  });
});

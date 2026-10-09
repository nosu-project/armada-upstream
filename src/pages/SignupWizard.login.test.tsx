/**
 * The page signup wizard's key-save step is the second call site that invokes
 * the now-asynchronous `login.nsec` fire-and-forget.
 *
 * It is the riskier of the two: `handleContinue` seeds that account's scoped
 * config with its home relays (`useSignupLists`) and then advances the wizard,
 * all on the assumption that the login it just requested is now the active
 * one. Advancing before
 * the login is durable leaves the wizard rendering nothing (the profile step
 * requires `user`), and a rejected persist has no handler at all.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  nsec: vi.fn<(key: string) => Promise<void>>(),
  toast: vi.fn(),
  seed: vi.fn(),
  publish: vi.fn(),
  user: undefined as { pubkey: string } | undefined,
}));

vi.mock("@/components/RelayListEditor", () => ({
  RelayListEditor: ({ relays, onChange }: { relays: string[]; onChange: (r: string[]) => void }) => (
    <div>
      <p>{relays.join(" ")}</p>
      <button onClick={() => onChange(["wss://mine.example"])}>Use my relay</button>
    </div>
  ),
}));
vi.mock("@/hooks/useSignupLists", () => ({ useSignupLists: () => ({ seed: h.seed, publish: h.publish }) }));
vi.mock("@/components/RelayLed", () => ({ RelayLed: () => null, BlossomLed: () => null }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
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
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: vi.fn(async () => {}) }));
vi.mock("@/lib/credentialManager", () => ({
  backUpNsec: vi.fn(async () => ({ status: "cancelled" as const })),
}));

import { SignupWizard } from "@/pages/SignupWizard";

/**
 * Satisfy the backup gate so Continue appears — it is absent rather than
 * disabled until then, and copying is reached by revealing the key, which
 * swaps the eye for a clipboard.
 */
async function reachContinue() {
  fireEvent.click(await screen.findByRole("button", { name: "Show key" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
  await screen.findByRole("button", { name: "Continue" });
}

beforeEach(() => {
  h.nsec.mockReset();
  h.toast.mockReset();
  h.seed.mockReset();
  h.publish.mockReset();
  h.user = undefined;
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
    // Continue is still there to try again with: the failure is the login's.
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(h.toast).toHaveBeenCalled();
  });

  it("asks for relays after the profile and publishes what is chosen", async () => {
    h.nsec.mockImplementation(async () => {
      h.user = { pubkey: "a".repeat(64) };
    });
    render(<SignupWizard onExit={vi.fn()} />);
    await reachContinue();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // Home relays are seeded before login, so the profile publishes there.
    await screen.findByText("set up your profile");
    expect(h.seed).toHaveBeenCalledWith(expect.any(String), ["wss://home.example"]);
    expect(h.publish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await screen.findByText("your relays");
    // Every list is one row; nothing is open until tapped.
    for (const label of ["Home", "Messages", "Search", "Media", "Communities", "Broadcast"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Use my relay" })).toBeNull();
    // The heading's ⓘ explains relays on tap, not only on hover.
    fireEvent.click(screen.getByRole("button", { name: "About relays" }));
    expect((await screen.findAllByText(/Relays are servers/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Home/ }));
    // An open row says what it is for.
    expect(await screen.findByText("Stores your profile, follows and settings.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Use my relay" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(h.publish).toHaveBeenCalledWith(
      h.nsec.mock.calls[0][0],
      expect.objectContaining({
        home: ["wss://mine.example"],
        search: ["wss://search.example"],
      }),
      undefined,
    );
  });
});

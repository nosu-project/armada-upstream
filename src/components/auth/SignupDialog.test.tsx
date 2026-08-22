/**
 * `login.nsec` became asynchronous when adding an account while one is active
 * turned into a full account switch (`addAndSwitchAccount` → persist → hard
 * reload). The signup surfaces are the two call sites that still invoke it
 * fire-and-forget.
 *
 * Today they are only reachable signed-out, so the in-place branch keeps them
 * working — but the safety is a runtime property of `useLoginActions`, not of
 * these components. Fire-and-forget here means the wizard dismisses (and, in
 * the page wizard, advances to a step that publishes a signed kind-10002)
 * before the login is durable, and a rejected persist has no handler at all.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const h = vi.hoisted(() => ({
  nsec: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock("@/components/onboarding/WizardShell", () => ({
  WizardShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/useLoginActions", () => ({
  useLoginActions: () => ({ nsec: h.nsec }),
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
});

describe("SignupDialog account creation", () => {
  it("dismisses only after the login has been persisted", async () => {
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

    // The login is still in flight: `addAndSwitchAccount` has not written the
    // durable login list yet, so nothing downstream may act on the new
    // account, and this flow must not report itself finished.
    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    settle();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the login could not be persisted", async () => {
    // `addAndSwitchAccount` rejects when the durable login list cannot be
    // written. Dismissing anyway tells the caller an account exists — and the
    // key it just made the user back up is the only copy of one that does not.
    h.nsec.mockRejectedValue(new Error("secure storage unavailable"));
    const onClose = vi.fn();
    const onComplete = vi.fn();

    render(<SignupDialog isOpen onClose={onClose} onComplete={onComplete} />);
    await reachEnabledContinue();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(h.nsec).toHaveBeenCalledTimes(1));
    // Give a fire-and-forget call every chance to run its continuation.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onComplete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

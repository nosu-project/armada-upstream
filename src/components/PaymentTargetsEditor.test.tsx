/**
 * Tests for the "Accept Donations" editor (NIP-A3 kind 10133).
 *
 * The editor has no save button of its own — the parent profile form drives it
 * through the imperative {@link PaymentTargetsEditorHandle.save}. These tests
 * pin that contract: the no-op short-circuit when nothing changed, the
 * validation gate (a bad address blocks the save and toasts), and the publish
 * on a real change. They also cover seeding drafts from loaded targets.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PaymentTargetsEditor,
  type PaymentTargetsEditorHandle,
} from "./PaymentTargetsEditor";
import type { PaymentTarget } from "@/lib/paymentTargets";

const SELF = "a".repeat(64);

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  targets: [] as PaymentTarget[],
  isLoading: false,
  update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/usePaymentTargets", () => ({
  usePaymentTargets: () => ({ targets: h.targets, isLoading: h.isLoading }),
  useUpdatePaymentTargets: () => ({ mutateAsync: h.update }),
}));
vi.mock("@/hooks/useToast", () => ({
  useToast: () => ({ toast: h.toast }),
}));

beforeEach(() => {
  h.user = { pubkey: SELF };
  h.targets = [];
  h.isLoading = false;
  h.update.mockReset().mockResolvedValue(undefined);
  h.toast.mockReset();
});

describe("PaymentTargetsEditor", () => {
  it("renders the empty state when the user has no targets", () => {
    render(<PaymentTargetsEditor />);
    expect(screen.getByText("Accept Donations")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add donation/i })).toBeInTheDocument();
  });

  it("returns null when logged out", () => {
    h.user = undefined;
    const { container } = render(<PaymentTargetsEditor />);
    expect(container).toBeEmptyDOMElement();
  });

  it("seeds a draft row from a loaded target", () => {
    h.targets = [{ type: "monero", authority: "4".repeat(95) }];
    render(<PaymentTargetsEditor />);
    const input = screen.getByLabelText("Monero address") as HTMLInputElement;
    expect(input.value).toBe("4".repeat(95));
  });

  it("save() is a no-op that resolves true when nothing changed", async () => {
    h.targets = [{ type: "lightning", authority: "you@example.com" }];
    const ref = createRef<PaymentTargetsEditorHandle>();
    render(<PaymentTargetsEditor ref={ref} />);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await ref.current!.save();
    });
    expect(ok).toBe(true);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("save() blocks and toasts on an invalid address", async () => {
    h.targets = [{ type: "monero", authority: "4".repeat(95) }];
    const ref = createRef<PaymentTargetsEditorHandle>();
    render(<PaymentTargetsEditor ref={ref} />);

    const input = screen.getByLabelText("Monero address");
    fireEvent.change(input, { target: { value: "not-a-real-address" } });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await ref.current!.save();
    });

    expect(ok).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });

  it("save() publishes the cleaned target set on a real change", async () => {
    h.targets = [{ type: "monero", authority: "4".repeat(95) }];
    const ref = createRef<PaymentTargetsEditorHandle>();
    render(<PaymentTargetsEditor ref={ref} />);

    const next = "8" + "b".repeat(94);
    const input = screen.getByLabelText("Monero address");
    fireEvent.change(input, { target: { value: next } });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await ref.current!.save();
    });

    expect(ok).toBe(true);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith([{ type: "monero", authority: next }]);
  });

  it("save() drops an emptied row rather than treating it as invalid", async () => {
    h.targets = [{ type: "monero", authority: "4".repeat(95) }];
    const ref = createRef<PaymentTargetsEditorHandle>();
    render(<PaymentTargetsEditor ref={ref} />);

    const input = screen.getByLabelText("Monero address");
    fireEvent.change(input, { target: { value: "   " } });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await ref.current!.save();
    });

    expect(ok).toBe(true);
    expect(h.toast).not.toHaveBeenCalled();
    // Went from one target to none → a real change, published as an empty set.
    expect(h.update).toHaveBeenCalledWith([]);
  });
});

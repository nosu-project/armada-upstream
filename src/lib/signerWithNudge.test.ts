import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrSigner } from "@nostrify/types";

import { toast } from "@/hooks/useToast";
import { signerWithNudge } from "@/lib/signerWithNudge";

vi.mock("@/hooks/useToast", () => ({
  toast: vi.fn(() => ({ id: "t", dismiss: vi.fn(), update: vi.fn() })),
}));

const toastMock = vi.mocked(toast);

/** A controllable latch standing in for a pending upstream signer op. */
function gate(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A minimal upstream signer whose signEvent is externally controlled. */
function makeUpstream() {
  const g = gate();
  const upstream: NostrSigner = {
    getPublicKey: vi.fn(async () => {
      await g.promise;
      return "ab".repeat(32);
    }),
    signEvent: vi.fn(async (t) => {
      await g.promise;
      return { ...(t as object), id: "x", pubkey: "ab".repeat(32), sig: "s" } as never;
    }),
    nip44: {
      encrypt: vi.fn(async (_p: string, pt: string) => `ct:${pt}`),
      decrypt: vi.fn(async (_p: string, ct: string) => `pt:${ct}`),
    },
  };
  return { upstream, gate: g };
}

const TEMPLATE = { kind: 9, content: "hi", tags: [], created_at: 1_700_000_000 };

beforeEach(() => {
  vi.useFakeTimers();
  toastMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("signerWithNudge", () => {
  it("passes fast ops straight through without nudging", async () => {
    const { upstream, gate } = makeUpstream();
    gate.resolve();
    const wrapped = signerWithNudge(upstream);

    await expect(wrapped.getPublicKey()).resolves.toBe("ab".repeat(32));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("nudges after 4s on a slow op, then confirms when it lands", async () => {
    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream, () => true);

    const p = wrapped.signEvent(TEMPLATE);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Approve message" }),
    );

    gate.resolve();
    await expect(p).resolves.toMatchObject({ id: "x" });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Signing approved", variant: "success" }),
    );
  });

  it("warns about relay connectivity instead when no bunker socket is open", async () => {
    // Clear the throttle window left by the previous test's nudge.
    await vi.advanceTimersByTimeAsync(9_000);

    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream, () => false);

    const p = wrapped.signEvent(TEMPLATE);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Signer relay unreachable" }),
    );

    gate.resolve();
    await expect(p).resolves.toBeTruthy();
  });

  it("hard-times-out an op that never settles", async () => {
    await vi.advanceTimersByTimeAsync(9_000);

    const { upstream } = makeUpstream(); // gate never resolved
    const wrapped = signerWithNudge(upstream, () => true);

    const p = wrapped.getPublicKey();
    const assertion = expect(p).rejects.toThrow("Signer timed out");
    await vi.advanceTimersByTimeAsync(65_000);
    await assertion;
  });

  it("propagates underlying signer errors", async () => {
    const { upstream, gate } = makeUpstream();
    const wrapped = signerWithNudge(upstream);

    const p = wrapped.getPublicKey();
    const assertion = expect(p).rejects.toThrow("user rejected");
    gate.reject(new Error("user rejected"));
    await assertion;
  });

  it("passes crypto through unwrapped (no per-ciphertext nudges)", () => {
    const { upstream } = makeUpstream();
    const wrapped = signerWithNudge(upstream);
    expect(wrapped.nip44).toBe(upstream.nip44);
  });

  it("forwards isDecryptCached and signPsbt from the underlying signer", async () => {
    const { upstream, gate } = makeUpstream();
    gate.resolve();
    const peek = vi.fn(async (_m: string, _cp: string, _ct: string) => true);
    const signPsbt = vi.fn(async (hex: string) => `signed:${hex}`);
    const rich = Object.assign(upstream, { isDecryptCached: peek, signPsbt });

    const wrapped = signerWithNudge(rich) as NostrSigner & {
      isDecryptCached: typeof peek;
      signPsbt: typeof signPsbt;
    };

    await expect(wrapped.isDecryptCached("nip44", "cp", "ct")).resolves.toBe(true);
    expect(peek).toHaveBeenCalledWith("nip44", "cp", "ct");
    await expect(wrapped.signPsbt("deadbeef")).resolves.toBe("signed:deadbeef");
    expect(signPsbt).toHaveBeenCalledWith("deadbeef");
  });
});

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRoleIntent } from "@/concord-v2/hooks/useRoleIntent";

const ALICE = "a".repeat(64);
const R1 = "1".repeat(64);
const R2 = "2".repeat(64);

describe("useRoleIntent (role toggles compose instead of racing)", () => {
  it("composes a second toggle on the FIRST one's intent, not the lagging fold", async () => {
    // The control fold only reflects a grant once the edition is published and
    // re-folded. Reading the base from it means two quick toggles both start
    // from the same stale set and the second silently drops the first's role.
    const folded: Record<string, string[]> = { [ALICE]: [] };
    const publish = vi.fn(async (_args: { member: string; roleIds: string[] }) => {});
    const { result } = renderHook(() => useRoleIntent(folded, publish));

    await act(async () => {
      await Promise.all([
        result.current.toggle(ALICE, R1, true),
        result.current.toggle(ALICE, R2, true),
      ]);
    });

    expect(publish).toHaveBeenCalledTimes(2);
    // Whatever the interleaving, the LAST publish carries both roles.
    const last = publish.mock.calls.at(-1)![0];
    expect(last.member).toBe(ALICE);
    expect([...last.roleIds].sort()).toEqual([R1, R2].sort());
  });

  it("ignores a repeat toggle of the same role while one is in flight", async () => {
    const folded: Record<string, string[]> = { [ALICE]: [] };
    let release: (() => void) | undefined;
    const publish = vi.fn((_args: { member: string; roleIds: string[] }) => new Promise<void>((r) => { release = r; }));
    const { result } = renderHook(() => useRoleIntent(folded, publish));

    let first: Promise<unknown> | undefined;
    act(() => { first = result.current.toggle(ALICE, R1, true); });
    // The double-click: same role, same member, before the first settles.
    act(() => { void result.current.toggle(ALICE, R1, true); });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(result.current.isPending(ALICE, R1)).toBe(true);

    await act(async () => { release!(); await first; });
    expect(result.current.isPending(ALICE, R1)).toBe(false);
  });

  it("drops the local intent once the fold agrees, so an external change wins", async () => {
    const publish = vi.fn(async (_args: { member: string; roleIds: string[] }) => {});
    const folded: Record<string, string[]> = { [ALICE]: [] };
    const { result, rerender } = renderHook(({ f }) => useRoleIntent(f, publish), {
      initialProps: { f: folded },
    });

    await act(async () => { await result.current.toggle(ALICE, R1, true); });

    // The fold catches up, then someone ELSE revokes the role elsewhere. The
    // overlay must not resurrect it on the next toggle.
    rerender({ f: { [ALICE]: [R1] } });
    rerender({ f: { [ALICE]: [] } });
    await act(async () => { await result.current.toggle(ALICE, R2, true); });

    const last = publish.mock.calls.at(-1)![0];
    expect(last.roleIds).toEqual([R2]);
  });

  it("reports a publish failure and forgets the intent", async () => {
    const folded: Record<string, string[]> = { [ALICE]: [] };
    const publish = vi.fn(async (_args: { member: string; roleIds: string[] }) => { throw new Error("relay refused"); });
    const { result } = renderHook(() => useRoleIntent(folded, publish));

    await expect(
      act(async () => { await result.current.toggle(ALICE, R1, true); }),
    ).rejects.toThrow("relay refused");
    expect(result.current.isPending(ALICE, R1)).toBe(false);

    // The failed grant left no phantom intent behind.
    await act(async () => { await result.current.toggle(ALICE, R2, true).catch(() => {}) });
    const last = publish.mock.calls.at(-1)![0];
    expect(last.roleIds).toEqual([R2]);
  });
});

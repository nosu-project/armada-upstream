/**
 * The fold scheduler's two bounds.
 *
 * Deferring a fold is a trade against a frame that is ALREADY PAINTED, and the
 * hook is only correct while it stays that trade. The plain "cancel the pending
 * idle callback on every dependency change and arm a fresh one" schedule is not:
 *
 *  - it never runs at all under a burst, because each re-arm resets the idle
 *    callback's own `timeout` along with the callback. A cold boot is exactly a
 *    burst — the wire ingests a replay and rings `c2ctl:<id>` (coalesced at
 *    50ms), and each ring re-seeds the control events the fold depends on. With
 *    the fold unrun, `channels` is `[]`, so there is no `Channel`, so the
 *    channel timeline's query stays DISABLED and the chat pane sits empty —
 *    with the messages already on disk.
 *
 *  - it defers even when there is nothing painted to protect. A first-ever open
 *    has no persisted snapshot and no memo entry, so the deferral buys an empty
 *    frame instead of a cached one, and everything downstream waits on it.
 *
 * These tests pin both: the fold runs immediately when nothing is painted, and
 * once something IS painted a burst delays it by at most the deadline.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDeferredFold } from "./useDeferredFold";

// The snapshot store is irrelevant here — these tests are about WHEN compute
// runs, and a real read would race the scheduler with its own state update.
vi.mock("@/lib/foldedCache", () => ({
  encode: (value: unknown) => JSON.stringify(value),
  readFolded: vi.fn(async () => undefined),
  readFoldedShared: vi.fn(async () => undefined),
  writeFolded: vi.fn(async () => undefined),
}));

/**
 * A `requestIdleCallback` that grants a slot only when a test says so — i.e. a
 * main thread that is busy by default, which is the condition the scheduler has
 * to survive.
 */
function installIdleStub() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => {
    pending.delete(id);
  });
  return {
    get armed(): number {
      return pending.size;
    },
    /** Grant an idle slot to everything currently armed. */
    grant(): void {
      const callbacks = [...pending.values()];
      pending.clear();
      act(() => {
        for (const cb of callbacks) cb();
      });
    },
  };
}

// `Date.now` drives the deadline, so it has to advance under the test's control.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDeferredFold scheduling", () => {
  it("folds without waiting for an idle slot when nothing is painted", () => {
    const idle = installIdleStub();
    const compute = vi.fn(() => "folded");

    const { result } = renderHook(() => useDeferredFold("nothing-painted", compute, [1]));

    // No idle slot was ever granted, and the value is already on screen.
    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("folded");
    expect(idle.armed).toBe(0);
  });

  it("defers once there is something painted, and folds on the idle slot", () => {
    const idle = installIdleStub();
    let generation = 0;
    const compute = vi.fn(() => `fold-${generation}`);

    const { result, rerender } = renderHook(
      ({ dep }) => useDeferredFold("defers-when-painted", compute, [dep]),
      { initialProps: { dep: 0 } },
    );
    expect(result.current).toBe("fold-0");

    // With `fold-0` painted, the next dependency change is deferred rather than
    // run inline.
    generation = 1;
    rerender({ dep: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(idle.armed).toBe(1);
    expect(result.current).toBe("fold-0");

    idle.grant();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("fold-1");
  });

  it("a dependency burst delays the fold by the deadline, not indefinitely", () => {
    installIdleStub(); // no slot is ever granted
    let generation = 0;
    const compute = vi.fn(() => `fold-${generation}`);

    const { result, rerender } = renderHook(
      ({ dep }) => useDeferredFold("burst", compute, [dep]),
      { initialProps: { dep: 0 } },
    );
    expect(compute).toHaveBeenCalledTimes(1);

    // The wire's bus coalesces at 50ms; four rings is well inside the deadline.
    for (let i = 1; i <= 4; i++) {
      generation = i;
      vi.advanceTimersByTime(50);
      rerender({ dep: i });
    }
    // Still deferred — a burst that stops here is a burst that cost nothing.
    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("fold-0");

    // Past the deadline, the reschedule stops rescheduling and folds. The
    // deadline was set on the FIRST deferral of this period and no re-arm moved
    // it, which is the whole point.
    generation = 5;
    vi.advanceTimersByTime(200);
    rerender({ dep: 5 });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("fold-5");
  });

  it("re-arms the deadline after each fold, so a later burst is bounded too", () => {
    installIdleStub();
    let generation = 0;
    const compute = vi.fn(() => `fold-${generation}`);

    const { result, rerender } = renderHook(
      ({ dep }) => useDeferredFold("re-arms", compute, [dep]),
      { initialProps: { dep: 0 } },
    );

    // Burn through one deadline period.
    generation = 1;
    rerender({ dep: 1 });
    vi.advanceTimersByTime(300);
    generation = 2;
    rerender({ dep: 2 });
    expect(result.current).toBe("fold-2");

    // The next change starts a FRESH deadline rather than being immediately
    // overdue — otherwise every subsequent fold would run inline and the hook
    // would be a `useMemo` again.
    generation = 3;
    rerender({ dep: 3 });
    expect(result.current).toBe("fold-2");

    vi.advanceTimersByTime(300);
    generation = 4;
    rerender({ dep: 4 });
    expect(result.current).toBe("fold-4");
  });
});

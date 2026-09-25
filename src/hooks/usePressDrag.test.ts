// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePressDrag } from "./usePressDrag";

/**
 * jsdom has no PointerEvent, so pointer events are plain Events carrying the
 * fields the hook reads. That is enough: the hook only ever looks at
 * `pointerId`, `pointerType`, `button` and the client coordinates.
 */
function pointer(type: string, init: Partial<PointerEvent> = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  return Object.assign(ev, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 0,
    clientY: 0,
    ...init,
  }) as unknown as PointerEvent;
}

function setup(container?: HTMLElement) {
  const calls = {
    onPickup: vi.fn(),
    onAim: vi.fn(),
    onDrop: vi.fn(),
    onAbort: vi.fn(),
  };
  const containerRef = { current: null as HTMLElement | null };
  const view = renderHook(() => usePressDrag<string>({ containerRef, ...calls }));
  if (container) act(() => view.result.current.attachContainer(container));
  return { ...view, calls, containerRef };
}

describe("usePressDrag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("picks up after the hold, aims on move, and drops on release", () => {
    const { result, calls } = setup();

    act(() => {
      result.current.begin("row-a")(pointer("pointerdown", { clientY: 50 }));
    });
    expect(calls.onPickup).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(300));
    expect(calls.onPickup).toHaveBeenCalledWith("row-a", 0, 50);
    expect(result.current.dragging).toBe(true);
    expect(result.current.source).toBe("row-a");

    act(() => void window.dispatchEvent(pointer("pointermove", { clientY: 120 })));
    expect(calls.onAim).toHaveBeenCalledWith("row-a", 0, 120);

    act(() => void window.dispatchEvent(pointer("pointerup", { clientY: 120 })));
    expect(calls.onDrop).toHaveBeenCalledWith("row-a");
    expect(calls.onAbort).not.toHaveBeenCalled();
    expect(result.current.dragging).toBe(false);
  });

  it("suppresses the click the browser synthesizes after a drop that moved", () => {
    const { result } = setup();
    act(() => {
      result.current.begin("row-a")(pointer("pointerdown", { clientY: 50 }));
      vi.advanceTimersByTime(300);
      // A real drag travels before release; that's what makes it a drop.
      window.dispatchEvent(pointer("pointermove", { clientY: 120 }));
      window.dispatchEvent(pointer("pointerup", { clientY: 120 }));
    });
    expect(result.current.shouldSuppressClick()).toBe(true);
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current.shouldSuppressClick()).toBe(false);
  });

  it("a stationary hold navigates: no drop, no click suppression", () => {
    // The lost-tap fix: holding an entry past PICKUP_MS then releasing WITHOUT
    // moving is a tap the user held too long, not a reorder. It must not swallow
    // the navigation click.
    const { result, calls } = setup();
    act(() => {
      result.current.begin("row-a")(pointer("pointerdown", { clientY: 50 }));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointer("pointerup", { clientY: 50 }));
    });
    expect(calls.onPickup).toHaveBeenCalled(); // it did pick up (the hold elapsed)
    expect(calls.onDrop).not.toHaveBeenCalled(); // but never applied a drop
    expect(calls.onAbort).toHaveBeenCalled(); // it aborted the in-place pickup
    expect(result.current.shouldSuppressClick()).toBe(false); // click navigates
  });

  it("aborts without dropping when the browser reclaims the pointer", () => {
    const { result, calls } = setup();
    act(() => {
      result.current.begin("row-a")(pointer("pointerdown"));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointer("pointercancel"));
    });
    expect(calls.onAbort).toHaveBeenCalled();
    expect(calls.onDrop).not.toHaveBeenCalled();
    expect(result.current.dragging).toBe(false);
  });

  it("ignores a second pointer's move and release", () => {
    const { result, calls } = setup();
    act(() => {
      result.current.begin("row-a")(pointer("pointerdown"));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointer("pointermove", { pointerId: 2, clientY: 400 }));
      window.dispatchEvent(pointer("pointerup", { pointerId: 2 }));
    });
    expect(calls.onAim).not.toHaveBeenCalled();
    expect(calls.onDrop).not.toHaveBeenCalled();
    expect(result.current.dragging).toBe(true);
  });

  it("mouse movement during the hold neither picks up early nor cancels", () => {
    const { result, calls } = setup();
    act(() => {
      result.current.begin("row-a")(pointer("pointerdown", { clientY: 50 }));
      window.dispatchEvent(pointer("pointermove", { clientY: 90 }));
    });
    expect(calls.onPickup).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(300));
    // Picked up where the cursor IS, not where the press landed.
    expect(calls.onPickup).toHaveBeenCalledWith("row-a", 0, 90);
  });

  it("turns early touch movement into a hand-panned scroll, never a drag", () => {
    const container = document.createElement("div");
    container.scrollTop = 100;
    const { result, calls } = setup(container);

    act(() => {
      result.current.begin("row-a")(
        pointer("pointerdown", { pointerType: "touch", clientY: 200 }),
      );
      // The move that breaks the slop classifies the gesture; panning starts
      // from there, so the delta is measured against it and not the press.
      window.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientY: 180 }));
      window.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientY: 160 }));
      vi.advanceTimersByTime(300);
    });

    expect(calls.onPickup).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(120);
  });

  describe("the hand-panned scroll's fling", () => {
    /** A container jsdom will let scroll: scrollTop clamps to [0, 1000]. */
    function scrollable() {
      const el = document.createElement("div");
      let top = 0;
      Object.defineProperty(el, "scrollTop", {
        get: () => top,
        set: (v: number) => void (top = Math.max(0, Math.min(1000, v))),
      });
      document.body.append(el);
      return el;
    }

    /** Swipes up from y=400 to y=200 in 10ms steps, then lifts. */
    function swipeUp(begin: (e: PointerEvent) => void) {
      begin(pointer("pointerdown", { pointerType: "touch", clientY: 400 }));
      for (let y = 380; y >= 200; y -= 20) {
        vi.advanceTimersByTime(10);
        window.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientY: y }));
      }
      window.dispatchEvent(pointer("pointerup", { pointerType: "touch", clientY: 200 }));
    }

    it("coasts on after a quick release, then stops", () => {
      const container = scrollable();
      const { result } = setup(container);
      act(() => swipeUp(result.current.begin("row-a")));
      const released = container.scrollTop;
      expect(released).toBe(180);

      act(() => void vi.advanceTimersByTime(100));
      expect(container.scrollTop).toBeGreaterThan(released);
      act(() => void vi.advanceTimersByTime(5000));
      const settled = container.scrollTop;
      act(() => void vi.advanceTimersByTime(500));
      expect(container.scrollTop).toBe(settled);
      container.remove();
    });

    it("does not coast when the finger rested before lifting", () => {
      const container = scrollable();
      const { result } = setup(container);
      act(() => {
        const begin = result.current.begin("row-a");
        begin(pointer("pointerdown", { pointerType: "touch", clientY: 400 }));
        window.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientY: 380 }));
        vi.advanceTimersByTime(10);
        window.dispatchEvent(pointer("pointermove", { pointerType: "touch", clientY: 300 }));
        vi.advanceTimersByTime(200);
        window.dispatchEvent(pointer("pointerup", { pointerType: "touch", clientY: 300 }));
      });
      const released = container.scrollTop;
      act(() => void vi.advanceTimersByTime(1000));
      expect(container.scrollTop).toBe(released);
      container.remove();
    });

    it("is caught by a touch, whose tap does not click", () => {
      const container = scrollable();
      const { result, calls } = setup(container);
      act(() => swipeUp(result.current.begin("row-a")));
      act(() => void vi.advanceTimersByTime(50));

      act(() => {
        const down = pointer("pointerdown", { pointerType: "touch", clientY: 300 });
        container.dispatchEvent(down);
        result.current.begin("row-b")(down);
      });
      const caught = container.scrollTop;
      act(() => void vi.advanceTimersByTime(100));
      expect(container.scrollTop).toBe(caught);

      act(() => void window.dispatchEvent(pointer("pointerup", { pointerType: "touch", clientY: 300 })));
      expect(result.current.shouldSuppressClick()).toBe(true);
      expect(calls.onDrop).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(300));
      expect(result.current.shouldSuppressClick()).toBe(false);
      container.remove();
    });

    it("an ordinary tap at rest still clicks", () => {
      const container = scrollable();
      const { result } = setup(container);
      act(() => {
        const down = pointer("pointerdown", { pointerType: "touch", clientY: 300 });
        container.dispatchEvent(down);
        result.current.begin("row-a")(down);
        window.dispatchEvent(pointer("pointerup", { pointerType: "touch", clientY: 300 }));
      });
      expect(result.current.shouldSuppressClick()).toBe(false);
      container.remove();
    });
  });

  describe("the touchmove canceller", () => {
    it("is attached to the container as it mounts, before any gesture", () => {
      const container = document.createElement("div");
      const add = vi.spyOn(container, "addEventListener");
      setup(container);
      expect(add).toHaveBeenCalledWith("touchmove", expect.any(Function), { passive: false });
    });

    it("cancels touchmove only while a drag is live", () => {
      const container = document.createElement("div");
      document.body.append(container);
      const { result } = setup(container);

      // At rest the container scrolls natively.
      const before = new Event("touchmove", { bubbles: true, cancelable: true });
      container.dispatchEvent(before);
      expect(before.defaultPrevented).toBe(false);

      act(() => {
        result.current.begin("row-a")(pointer("pointerdown", { pointerType: "touch" }));
        vi.advanceTimersByTime(300);
      });

      const during = new Event("touchmove", { bubbles: true, cancelable: true });
      container.dispatchEvent(during);
      expect(during.defaultPrevented).toBe(true);

      container.remove();
    });
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SnapSheet } from "./SnapSheet";

const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
});

afterAll(() => {
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
});

function touch(y: number) {
  return { touches: [{ clientX: 100, clientY: y }], changedTouches: [{ clientX: 100, clientY: y }] };
}

describe("SnapSheet", () => {
  // Radix's Portal renders nothing on its first commit, so a sheet that wired
  // its drag from a ref at mount never wired it at all.
  it("follows a drag once it has opened", () => {
    render(
      <SnapSheet open onOpenChange={() => {}} expanded={false} onExpandedChange={() => {}} title="Sheet">
        <p>body</p>
      </SnapSheet>,
    );
    const content = screen.getByRole("dialog");
    const before = content.style.transform;
    expect(before).toMatch(/translate3d\(0(px)?, \d+(\.\d+)?px, 0(px)?\)/);

    fireEvent.touchStart(screen.getByText("body"), touch(500));
    fireEvent.touchMove(screen.getByText("body"), touch(490));
    fireEvent.touchMove(screen.getByText("body"), touch(440));
    expect(content.style.transform).not.toBe(before);
  });

  describe("settling", () => {
    // Frames are run by hand, at a time past the animation's end, so a settle
    // either lands on its stop or — if something cancelled it — never moves.
    let frames: Map<number, FrameRequestCallback>;
    let nextId = 0;
    const runFrames = () =>
      act(() => {
        const due = [...frames.values()];
        frames.clear();
        for (const cb of due) cb(performance.now() + 10_000);
      });

    beforeAll(() => {
      frames = new Map();
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        frames.set(++nextId, cb);
        return nextId;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        frames.delete(id);
      });
    });
    afterEach(() => frames.clear());
    afterAll(() => vi.restoreAllMocks());

    // Height 800 puts peek at 800 - peekHeight(800) = 352.
    const PEEK = "translate3d(0, 352px, 0)";

    function renderSheet() {
      render(
        <SnapSheet open onOpenChange={() => {}} expanded={false} onExpandedChange={() => {}} title="Sheet">
          <p>body</p>
        </SnapSheet>,
      );
      return screen.getByRole("dialog");
    }

    it("still reaches its stop when a tap lands mid-animation", () => {
      const content = renderSheet();
      expect(content.style.transform).not.toBe(PEEK);
      // A tap: touch down and up with no travel, while the rise is in flight.
      fireEvent.touchStart(screen.getByText("body"), touch(500));
      fireEvent.touchEnd(screen.getByText("body"), { touches: [], changedTouches: [{ clientX: 100, clientY: 500 }] });
      runFrames();
      expect(content.style.transform).toBe(PEEK);
    });

    it("lands on the re-measured stop when the screen resizes mid-animation", () => {
      const content = renderSheet();
      // A rotation to a 600px-tall screen: peek becomes 600 - peekHeight(600) = 260.
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
      try {
        act(() => {
          window.dispatchEvent(new Event("resize"));
        });
        expect(content.style.transform).toBe("translate3d(0, 260px, 0)");
        // The animation toward the old stop must not run on and overwrite it.
        runFrames();
        expect(content.style.transform).toBe("translate3d(0, 260px, 0)");
      } finally {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
      }
    });
  });
});

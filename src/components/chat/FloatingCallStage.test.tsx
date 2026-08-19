import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingCallStage } from "./FloatingCallStage";

/**
 * The desktop floating call window is placed once, in a layout effect, before
 * CallProvider has reparented the stage host into it — `registerSlot` is a
 * passive effect, so the content lands a commit later. Measuring the panel at
 * that moment reports a header-only height for something about to be several
 * times taller, and clamping against it opens the window a full body-height too
 * low, hanging off the bottom edge until the ResizeObserver drags it back up.
 *
 * The guard below is written to be independent of the panel's actual chrome
 * constants: whatever `offsetHeight` reports while the panel is still empty,
 * the initial placement must be the same. `ResizeObserver` is a no-op stub in
 * the test setup, so what these assertions see is the INITIAL placement alone,
 * uncorrected.
 */
describe("FloatingCallStage placement and entry", () => {
  const realMatchMedia = window.matchMedia;
  let offsetHeight = 0;

  beforeEach(() => {
    localStorage.clear();
    // The component renders nothing below the `sidebar` breakpoint; the shared
    // setup's matchMedia stub answers `false` to everything.
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    // jsdom performs no layout, so `offsetHeight` is 0 unless stubbed — which
    // would make the premature-measurement bug invisible here.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => offsetHeight,
    });
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  });

  /** Mount the window and hand back its root panel element. */
  function renderPanel(measuredHeight: number) {
    offsetHeight = measuredHeight;
    const { container, unmount } = render(
      <FloatingCallStage registerSlot={() => {}} onHide={() => {}} />,
    );
    const panel = container.querySelector<HTMLElement>("div.fixed");
    expect(panel).not.toBeNull();
    return { panel: panel!, unmount };
  }

  /** Mount the window and read back the top the layout effect committed. */
  function placedTop(measuredHeight: number): number {
    const { panel, unmount } = renderPanel(measuredHeight);
    const top = parseFloat(panel.style.top);
    unmount();
    return top;
  }

  it("places the panel from the estimated full height, not a premature measurement", () => {
    // 33px is the empty panel (header + border); ~258px is what it becomes once
    // the stage host is reparented in. The placement must not differ...
    const headerOnly = placedTop(33);
    const fullyGrown = placedTop(258);
    expect(headerOnly).toBe(fullyGrown);

    // ...and must leave the panel's full height on screen. Measured
    // header-only, the old placement sat ~1px above the bottom edge.
    expect(headerOnly).toBeGreaterThan(0);
    expect(window.innerHeight - headerOnly).toBeGreaterThan(200);
  });

  // `duration-200` is on the panel for the entry ANIMATION, but Tailwind emits
  // it as `transition-duration` as well, and `transition-property` defaults to
  // `all` — so without `transition-none` the placement above tweens `left`/`top`
  // and the panel glides in diagonally from the origin. jsdom applies no
  // stylesheet, so the emitted class is the assertable form of that invariant.
  it("never lets the panel's position tween", () => {
    const { panel, unmount } = renderPanel(33);

    expect(panel.className).toContain("transition-none");
    // The guard must not have cost the entry animation it sits beside.
    expect(panel.className).toContain("animate-in");

    unmount();
  });
});

// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { usePinScrollOrigin } from "./usePinScrollOrigin";

/**
 * The net under `rowFlash`'s fix. `scrollIntoView` was the caller that actually
 * bit, but focusing an input, an anchor jump and the on-screen keyboard all
 * scroll ancestors the same way — and while `SwipeReveal` parks the chat pane
 * off-screen, ANY of them can slide the shell into the frozen-touch state. The
 * shell is `overflow: hidden` to clip, never to scroll, so a non-zero offset on
 * it is a bug by construction whatever produced it.
 */
describe("usePinScrollOrigin", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mount() {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = el;
    const view = renderHook(() => usePinScrollOrigin(ref));
    return { el, view };
  }

  it("snaps a stray horizontal scroll back to the origin", () => {
    const { el } = mount();

    el.scrollLeft = 411;
    el.dispatchEvent(new Event("scroll"));

    expect(el.scrollLeft).toBe(0);
  });

  it("snaps a stray vertical scroll back too", () => {
    const { el } = mount();

    el.scrollTop = 120;
    el.dispatchEvent(new Event("scroll"));

    expect(el.scrollTop).toBe(0);
  });

  it("resets an offset that was already there when it mounted", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.scrollLeft = 411;
    const ref = createRef<HTMLElement>();
    (ref as { current: HTMLElement | null }).current = el;

    renderHook(() => usePinScrollOrigin(ref));

    expect(el.scrollLeft).toBe(0);
  });

  it("stops listening when unmounted", () => {
    const { el, view } = mount();

    view.unmount();
    el.scrollLeft = 411;
    el.dispatchEvent(new Event("scroll"));

    expect(el.scrollLeft).toBe(411);
  });

  it("does nothing without an element", () => {
    const ref = createRef<HTMLElement>();
    expect(() => renderHook(() => usePinScrollOrigin(ref))).not.toThrow();
  });
});

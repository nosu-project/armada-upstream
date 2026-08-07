import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { useMessagePermalink } from "./useMessagePermalink";

import type { ReactNode } from "react";

type Opts = Parameters<typeof useMessagePermalink>[0];

/** A router at `initialPath`, plus a reader for where it ended up. */
function harness(initialPath: string) {
  let path = initialPath;
  function Spy() {
    const location = useLocation();
    path = location.pathname;
    return null;
  }
  return {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[initialPath]}>
        <Spy />
        {children}
      </MemoryRouter>
    ),
    at: () => path,
  };
}

describe("useMessagePermalink", () => {
  it("scrolls to the target once, and leaves the segment in the URL", () => {
    const { wrapper, at } = harness("/s/relay.example/g/m/m2");
    const scrollTo = vi.fn(() => true);
    const { rerender } = renderHook((props: Opts) => useMessagePermalink(props), {
      initialProps: { messages: [{ id: "m1" }, { id: "m2" }], isLoading: false, scrollTo },
      wrapper,
    });

    expect(scrollTo).toHaveBeenCalledWith("m2");
    // A permalink names where the reader is: refreshing must return there.
    expect(at()).toBe("/s/relay.example/g/m/m2");

    // Someone else posts. The reader must not be yanked back to the target.
    rerender({
      messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      isLoading: false,
      scrollTo,
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("leaves a thread reply's permalink to the thread panel", () => {
    const { wrapper, at } = harness("/s/relay.example/g/t/r1/m/reply");
    const scrollTo = vi.fn(() => true);
    renderHook((props: Opts) => useMessagePermalink(props), {
      // The reply isn't in the timeline and never will be; the timeline
      // instance must neither hunt it nor strip it out from under the panel.
      initialProps: { messages: [{ id: "r1" }], isLoading: false, scrollTo },
      wrapper,
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(at()).toBe("/s/relay.example/g/t/r1/m/reply");
  });

  it("leaves a timeline message's permalink to the timeline", () => {
    const { wrapper, at } = harness("/s/relay.example/g/m/m2");
    const scrollTo = vi.fn(() => true);
    renderHook((props: Opts) => useMessagePermalink(props), {
      initialProps: { messages: [{ id: "m2" }], isLoading: false, scrollTo, scope: "thread" },
      wrapper,
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(at()).toBe("/s/relay.example/g/m/m2");
  });

  it("drops an unresolvable target, keeping the open thread", () => {
    const { wrapper, at } = harness("/c/comm/ch/t/r1/m/gone");
    const scrollTo = vi.fn(() => false);
    renderHook((props: Opts) => useMessagePermalink(props), {
      initialProps: { messages: [{ id: "r1" }], isLoading: false, scrollTo, scope: "thread" },
      wrapper,
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(at()).toBe("/c/comm/ch/t/r1");
  });

  it("hunts older pages for a target below the loaded window, then gives up", async () => {
    const { wrapper, at } = harness("/dm/npub1abc/m/old");
    const loadOlder = vi.fn(() => Promise.resolve(0));
    const { rerender } = renderHook((props: Opts) => useMessagePermalink(props), {
      initialProps: {
        messages: [{ id: "m1" }],
        isLoading: false,
        hasMore: true,
        loadOlder,
        scrollTo: () => false,
      },
      wrapper,
    });

    // Each settled pull re-runs the hunt; it is bounded, and the segment is
    // replaced away once the bound is reached (a link that will never resolve
    // must not re-run the round-trips on every remount, forever).
    for (let i = 0; i < 10; i++) {
      await act(async () => {});
      rerender({
        messages: [{ id: "m1" }],
        isLoading: false,
        hasMore: true,
        loadOlder,
        scrollTo: () => false,
      });
    }
    expect(loadOlder).toHaveBeenCalledTimes(8);
    expect(at()).toBe("/dm/npub1abc");
  });

  it("returns a callback that drops the focus (what a send calls)", () => {
    const { wrapper, at } = harness("/c/comm/ch/m/m2");
    const { result } = renderHook((props: Opts) => useMessagePermalink(props), {
      initialProps: { messages: [{ id: "m2" }], isLoading: false, scrollTo: () => true },
      wrapper,
    });

    act(() => result.current());
    expect(at()).toBe("/c/comm/ch");
  });
});

import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { useTimelineFocus } from "./useTimelineFocus";

import type { MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import type { ReactNode } from "react";

function harness(initialPath: string) {
  let path = initialPath;
  function Spy() {
    path = useLocation().pathname;
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

function mountTimeline(result: { current: ReturnType<typeof useTimelineFocus> }, loaded: string[]) {
  const scrollToMessage = vi.fn((id: string) => loaded.includes(id));
  result.current.timelineRef.current = {
    scrollToMessage,
    pinToBottom: vi.fn(),
    maintainBottom: vi.fn(),
  } satisfies MessageTimelineHandle;
  return scrollToMessage;
}

describe("useTimelineFocus", () => {
  it("scrolls to a loaded message without touching the route", () => {
    const { wrapper, at } = harness("/c/comm/ch");
    const { result } = renderHook(
      () => useTimelineFocus({ messages: [{ id: "m1" }], isLoading: false }),
      { wrapper },
    );
    const scroll = mountTimeline(result, ["m1"]);

    act(() => result.current.jumpToMessage("m1"));
    expect(scroll).toHaveBeenCalledWith("m1");
    expect(at()).toBe("/c/comm/ch");
  });

  it("hands an unloaded message to the permalink hunt", () => {
    const { wrapper, at } = harness("/c/comm/ch");
    const { result } = renderHook(
      () => useTimelineFocus({ messages: [{ id: "m1" }], isLoading: false, hasMore: true, loadOlder: () => new Promise(() => {}) }),
      { wrapper },
    );
    const jump = result.current.jumpToMessage;
    mountTimeline(result, ["m1"]);

    act(() => result.current.jumpToMessage("old"));
    expect(at()).toBe("/c/comm/ch/m/old");
    // Rows hold the callback in memo props, so navigation must not replace it.
    expect(result.current.jumpToMessage).toBe(jump);
  });

  it("leaves a thread route alone, whose /m/ belongs to the thread panel", () => {
    const { wrapper, at } = harness("/c/comm/ch/t/root");
    const { result } = renderHook(
      () => useTimelineFocus({ messages: [], isLoading: false }),
      { wrapper },
    );
    mountTimeline(result, []);

    act(() => result.current.jumpToMessage("old"));
    expect(at()).toBe("/c/comm/ch/t/root");
  });
});

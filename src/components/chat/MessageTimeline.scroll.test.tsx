import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallback, useState } from "react";

import { MessageTimeline } from "@/components/chat/MessageTimeline";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

const resizeCallbacks: ResizeObserverCallback[] = [];
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

// Geometry for every current/future timeline row. Computing from live DOM order
// is important: newly revealed rows exist before the component's layout effect,
// exactly when the anchor restoration reads their offsets.
let growthAfterRow = Number.POSITIVE_INFINITY;
let growthPx = 0;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect(this: HTMLElement) {
      const scroller = this.closest<HTMLElement>(".scrollbar-stable");
      if (this.classList.contains("scrollbar-stable")) return domRect(0, this.clientHeight);
      if (!this.hasAttribute("data-scroll-anchor") || !scroller) return domRect(0, 0);
      const rows = [...(this.parentElement?.querySelectorAll<HTMLElement>("[data-scroll-anchor]") ?? [])];
      const index = rows.indexOf(this);
      const absoluteTop = index * 100 + (index >= growthAfterRow ? growthPx : 0);
      return domRect(absoluteTop - scroller.scrollTop, 100);
    },
  });
});

afterAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: originalGetBoundingClientRect,
  });
});

beforeEach(() => {
  resizeCallbacks.length = 0;
  growthAfterRow = Number.POSITIVE_INFINITY;
  growthPx = 0;
});

function message(index: number): ChatMsg {
  return {
    id: `m${index}`,
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000 + index,
    kind: 9,
    content: `msg ${index}`,
    tags: [],
    sig: "",
  } as unknown as ChatMsg;
}

function domRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 100,
    bottom: top + height,
    left: 0,
    width: 100,
    height,
    toJSON: () => ({}),
  };
}

function transportOf(messages: ChatMsg[]): ChatTransport {
  return { messages, isLoading: false, canWrite: true, canModerate: false };
}

async function mountedTimeline(count: number) {
  const messages = Array.from({ length: count }, (_, index) => message(index));
  const rendered = render(
    <MessageTimeline
      transport={transportOf(messages)}
      renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
    />,
  );
  const oldestOpening = `chat:m${Math.max(0, count - 30)}`;
  await screen.findByText(oldestOpening);
  const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
  const content = scroller.firstElementChild as HTMLElement;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: {
      configurable: true,
      get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100 + growthPx,
    },
  });
  return { ...rendered, scroller, content };
}

function scroll(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

function rowViewportOffset(content: HTMLElement, scroller: HTMLElement, key: string): number {
  const row = content.querySelector<HTMLElement>(`[data-scroll-anchor="${key}"]`)!;
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

describe("MessageTimeline reading anchor", () => {
  it("preserves the visible row and pixel while revealing older days", async () => {
    const { scroller, content } = await mountedTimeline(100);

    // Establish the same bookkeeping a real opening pin + upward gesture does.
    scroll(scroller, 2_500);
    scroll(scroller, 500);

    await waitFor(() => expect(screen.getByText("chat:m30")).toBeInTheDocument());
    expect(rowViewportOffset(content, scroller, "m75")).toBe(0);
    // Forty rows were revealed above m75; the viewport followed the row rather
    // than jumping forty messages (often several calendar days).
    expect(scroller.scrollTop).toBe(4_500);
  });

  it("preserves the visible row when an image or embed above it grows", async () => {
    const { scroller, content } = await mountedTimeline(40);
    scroll(scroller, 2_500);
    // Stay beyond the reveal threshold so this test isolates asynchronous
    // height changes from window extension.
    scroll(scroller, 1_000);

    expect(rowViewportOffset(content, scroller, "m20")).toBe(0);

    growthAfterRow = 5;
    growthPx = 240;
    act(() => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));

    expect(scroller.scrollTop).toBe(1_240);
    expect(rowViewportOffset(content, scroller, "m20")).toBe(0);
  });

  it("reveals a prior-day backfill at the top without requiring a second gesture", async () => {
    const loadOlder = vi.fn<() => Promise<number>>();

    function DmHistory() {
      const [messages, setMessages] = useState(() =>
        Array.from({ length: 30 }, (_, index) => message(index)),
      );
      const backfill = useCallback(async () => {
        const priorDay = Array.from({ length: 40 }, (_, index) => ({
          ...message(index - 40),
          id: `old${index}`,
          content: `old ${index}`,
          created_at: 1_700_000_000 - 3 * 24 * 60 * 60 + index,
        }));
        setMessages((current) => [...priorDay, ...current]);
        return priorDay.length;
      }, []);
      loadOlder.mockImplementation(backfill);
      return (
        <MessageTimeline
          transport={{
            ...transportOf(messages),
            hasMore: true,
            loadOlder,
          }}
          renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
        />
      );
    }

    const rendered = render(<DmHistory />);
    await screen.findByText("chat:m0");
    const scroller = rendered.container.querySelector<HTMLElement>(".scrollbar-stable")!;
    const content = scroller.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: {
        configurable: true,
        get: () => content.querySelectorAll("[data-scroll-anchor]").length * 100,
      },
    });

    scroll(scroller, 2_500);
    scroll(scroller, 0);

    await waitFor(() => expect(screen.getByText("chat:old0")).toBeInTheDocument());
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(content.querySelector('[data-scroll-anchor^="date-"]')).not.toBeNull();
    expect(rowViewportOffset(content, scroller, "m0")).toBe(0);
  });
});

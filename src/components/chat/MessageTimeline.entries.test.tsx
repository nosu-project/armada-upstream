import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import type { ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import { MessageTimeline, type MessageTimelineHandle } from "@/components/chat/MessageTimeline";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

// The shared setup stubs ResizeObserver as a plain function; the timeline
// constructs one to watch the scroller, so it needs a real constructor.
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

function message(id: string, createdAt: number, pubkey = "a".repeat(64)): ChatMsg {
  return { id, pubkey, created_at: createdAt, kind: 9, content: `msg ${id}`, tags: [], sig: "" } as unknown as ChatMsg;
}

function gitEntry(id: string, createdAt: number): ChannelTimelineEntry {
  // Shape-compatible stand-in: the timeline reads type/id/createdAt, plus the
  // activity's ticket and repository identity to decide grouping, and hands
  // the entry back to `renderEntry`. A distinct author per entry keeps each
  // one a row of its own, which is what these tests are counting.
  return {
    type: "git-ticket-opened",
    id,
    createdAt,
    activity: { id, ticket: { id, author: id, type: "issue" }, repository: { coordinate: "30617:x:repo" } },
  } as unknown as ChannelTimelineEntry;
}

function transportOf(messages: ChatMsg[]): ChatTransport {
  return { messages, isLoading: false, canWrite: true, canModerate: false };
}

function renderTimeline(entries: ChannelTimelineEntry[], messages: ChatMsg[]) {
  return render(
    <MessageTimeline
      transport={transportOf(messages)}
      entries={entries}
      renderMessage={(msg) => <span>chat:{msg.id}</span>}
      renderEntry={(entry) => <span>git:{entry.id}</span>}
    />,
  );
}

describe("MessageTimeline with generalized entries", () => {
  // A conversation opens with an empty commit and fills over the next frames,
  // so every row assertion waits for the ramp rather than the first paint.
  it("renders git entries interleaved with chat rows", async () => {
    const messages = [message("m1", 100), message("m2", 300)];
    const entries: ChannelTimelineEntry[] = [
      { type: "chat", id: "chat:m1", createdAt: 100, message: messages[0] } as ChannelTimelineEntry,
      gitEntry("t1", 200),
      { type: "chat", id: "chat:m2", createdAt: 300, message: messages[1] } as ChannelTimelineEntry,
    ];
    renderTimeline(entries, messages);

    expect(await screen.findByText("chat:m1")).toBeInTheDocument();
    expect(await screen.findByText("git:t1")).toBeInTheDocument();
    expect(await screen.findByText("chat:m2")).toBeInTheDocument();
  });

  it("windows over entries, so a git-only history still fills the opening window", async () => {
    // More git entries than the window: the newest must render even though
    // NONE of them are chat messages (the window used to be resolved over
    // `messages`, which is empty here — the whole channel would stay blank).
    const entries = Array.from({ length: 40 }, (_, i) => gitEntry(`t${i}`, 1000 + i));
    renderTimeline(entries, []);

    expect(await screen.findByText("git:t39")).toBeInTheDocument();
    // The oldest is outside the bounded window.
    expect(screen.queryByText("git:t0")).not.toBeInTheDocument();
  });

  it("keeps the empty state for a genuinely empty channel", () => {
    render(
      <MessageTimeline
        transport={transportOf([])}
        entries={[]}
        renderMessage={() => null}
        renderEntry={() => null}
        emptyState={<span>nothing here</span>}
      />,
    );
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });

  it("queues a message jump while the opening window is still mounting", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => message(`m${i}`, 1000 + i));
    const handle = createRef<MessageTimelineHandle>();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      render(
        <MessageTimeline
          transport={transportOf(messages)}
          handleRef={handle}
          renderMessage={(msg) => <span data-event-id={msg.id}>chat:{msg.id}</span>}
        />,
      );

      act(() => {
        expect(handle.current?.scrollToMessage("m5")).toBe(true);
      });

      expect(await screen.findByText("chat:m5")).toBeInTheDocument();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(3));
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});

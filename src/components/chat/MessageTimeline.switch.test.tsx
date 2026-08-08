import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MessageTimeline } from "@/components/chat/MessageTimeline";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

/**
 * Verifies the effect of dropping the per-channel `key` on the Concord
 * MessageTimeline (ConcordPage.tsx): a channel switch now updates the
 * timeline IN PLACE instead of tearing down and recreating the scroller +
 * ResizeObserver + scroll listeners (and flashing a skeleton).
 *
 * The `.scrollbar-stable` scroller (MessageTimeline.tsx:802) is the node whose
 * teardown the key used to force. Keeping the same DOM node across a
 * message-set swap is the observable proof the remount is gone; the keyed
 * control shows the contrast (a new node each switch).
 */

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

function message(id: string, createdAt: number): ChatMsg {
  return { id, pubkey: "a".repeat(64), created_at: createdAt, kind: 9, content: `msg ${id}`, tags: [], sig: "" } as unknown as ChatMsg;
}

function transportOf(messages: ChatMsg[]): ChatTransport {
  return { messages, isLoading: false, canWrite: true, canModerate: false };
}

const channelA = [message("a1", 100), message("a2", 200)];
const channelB = [message("b1", 300), message("b2", 400)];

async function scroller(container: HTMLElement): Promise<Element> {
  await waitFor(() => expect(container.querySelector(".scrollbar-stable")).toBeTruthy());
  return container.querySelector(".scrollbar-stable")!;
}

describe("MessageTimeline channel switch (no remount key)", () => {
  it("keeps the same scroller node across a channel switch (updates in place)", async () => {
    // How the Concord page now renders it: no key wrapping the timeline.
    const { container, rerender } = render(
      <MessageTimeline transport={transportOf(channelA)} renderMessage={(m) => <span>chat:{m.id}</span>} />,
    );
    expect(await screen.findByText("chat:a1")).toBeInTheDocument();
    const before = await scroller(container);

    // Switch channels: same slot, different data.
    rerender(
      <MessageTimeline transport={transportOf(channelB)} renderMessage={(m) => <span>chat:{m.id}</span>} />,
    );
    expect(await screen.findByText("chat:b1")).toBeInTheDocument();
    const after = await scroller(container);

    // Same DOM node ⇒ the scroller/observer/listeners were NOT rebuilt.
    expect(after).toBe(before);
    // And the old channel's messages are gone (the switch actually happened).
    expect(screen.queryByText("chat:a1")).not.toBeInTheDocument();
  });

  it("control: a per-channel key DOES remount the scroller (the old behavior)", async () => {
    const { container, rerender } = render(
      <MessageTimeline key="a" transport={transportOf(channelA)} renderMessage={(m) => <span>chat:{m.id}</span>} />,
    );
    expect(await screen.findByText("chat:a1")).toBeInTheDocument();
    const before = await scroller(container);

    rerender(
      <MessageTimeline key="b" transport={transportOf(channelB)} renderMessage={(m) => <span>chat:{m.id}</span>} />,
    );
    expect(await screen.findByText("chat:b1")).toBeInTheDocument();
    const after = await scroller(container);

    // Different DOM node ⇒ a full teardown+rebuild, which is what we removed.
    expect(after).not.toBe(before);
  });
});

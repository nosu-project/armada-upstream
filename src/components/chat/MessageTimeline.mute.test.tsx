/**
 * Muted authors must not reach the timeline, on any row type.
 *
 * `MessageTimeline` is the single funnel every chat surface renders through —
 * Concord, NIP-29, Buzz, DMs, mesh — so this is the filter that decides whether
 * "never displayed anywhere" holds for message content. The empty-state case is
 * the one with teeth: the timeline holds a skeleton over a source that briefly
 * empties, and a channel whose every row was muted away looks exactly like that
 * unless the skeleton is gated on the UNFILTERED entries.
 */

import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MutedPubkeysContext } from "@/contexts/MutedPubkeysContext";
import { MessageTimeline } from "@/components/chat/MessageTimeline";

import type { ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

const NOISY = "b".repeat(64);
const QUIET = "c".repeat(64);

function message(id: string, createdAt: number, pubkey: string): ChatMsg {
  return { id, pubkey, created_at: createdAt, kind: 9, content: `msg ${id}`, tags: [], sig: "" } as unknown as ChatMsg;
}

function chatEntry(msg: ChatMsg): ChannelTimelineEntry {
  return { type: "chat", id: `chat:${msg.id}`, createdAt: msg.created_at, message: msg } as ChannelTimelineEntry;
}

function gitEntry(id: string, createdAt: number, author: string): ChannelTimelineEntry {
  return {
    type: "git-ticket-opened",
    id,
    createdAt,
    activity: { id, ticket: { id, author, type: "issue" }, repository: { coordinate: "30617:x:repo" } },
  } as unknown as ChannelTimelineEntry;
}

function timerEntry(id: string, createdAt: number, author: string): ChannelTimelineEntry {
  return { type: "dm-timer", id, createdAt, author, seconds: 86400 };
}

function renderWithMutes(
  entries: ChannelTimelineEntry[],
  messages: ChatMsg[],
  muted: string[],
  ready = true,
) {
  const transport: ChatTransport = { messages, isLoading: false, canWrite: true, canModerate: false };
  return render(
    <MutedPubkeysContext.Provider value={{ mutedPubkeys: new Set(muted), ready }}>
      <MessageTimeline
        transport={transport}
        entries={entries}
        renderMessage={(msg) => <span>chat:{msg.id}</span>}
        renderEntry={(entry) => <span>entry:{entry.id}</span>}
        emptyState={<span>nothing here</span>}
      />
    </MutedPubkeysContext.Provider>,
  );
}

describe("MessageTimeline mute filtering", () => {
  it("drops a muted author's messages and keeps everyone else's", async () => {
    const keep = message("m1", 100, QUIET);
    const hide = message("m2", 200, NOISY);
    const alsoKeep = message("m3", 300, QUIET);
    renderWithMutes([chatEntry(keep), chatEntry(hide), chatEntry(alsoKeep)], [keep, hide, alsoKeep], [NOISY]);

    expect(await screen.findByText("chat:m1")).toBeInTheDocument();
    expect(await screen.findByText("chat:m3")).toBeInTheDocument();
    expect(screen.queryByText("chat:m2")).not.toBeInTheDocument();
  });

  it("drops non-chat rows by their own author field", async () => {
    // Each row type keeps its author somewhere different; `timelineEntryAuthor`
    // is what lets one filter cover all of them.
    const entries = [
      gitEntry("t1", 100, NOISY),
      gitEntry("t2", 200, QUIET),
      timerEntry("d1", 300, NOISY),
      timerEntry("d2", 400, QUIET),
    ];
    renderWithMutes(entries, [], [NOISY]);

    expect(await screen.findByText("entry:t2")).toBeInTheDocument();
    expect(await screen.findByText("entry:d2")).toBeInTheDocument();
    expect(screen.queryByText("entry:t1")).not.toBeInTheDocument();
    expect(screen.queryByText("entry:d1")).not.toBeInTheDocument();
  });

  it("shows the empty state — not a permanent skeleton — when every row was muted away", async () => {
    const hide = message("m1", 100, NOISY);
    renderWithMutes([chatEntry(hide)], [hide], [NOISY]);

    // No later poll can produce a row this filter admits, so holding the
    // loading skeleton here would hold it forever.
    expect(await screen.findByText("nothing here")).toBeInTheDocument();
    expect(screen.queryByText("chat:m1")).not.toBeInTheDocument();
  });

  it("renders everything while the mute set is still cold", async () => {
    // `ready: false` is a true cold start — no cached list, network in flight.
    // Hiding on the strength of a set we haven't loaded would be a guess.
    const msg = message("m1", 100, NOISY);
    renderWithMutes([chatEntry(msg)], [msg], [], false);

    expect(await screen.findByText("chat:m1")).toBeInTheDocument();
  });
});

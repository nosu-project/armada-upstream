/**
 * Ticket, comment and status rows. A channel row REFERS to a work item: it
 * stays about the size of a message however large the work item is, and the
 * full thing opens in the panel.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GitTimelineRow } from "@/components/chat/GitTimeline";

import type { GitChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { GitRepositoryAddress, GitTicket } from "@/lib/gitActivity";

// A spy rather than a stub: every rendered actor calls it exactly once, which
// is how the memoization tests below count renders without reaching into React.
const { useAuthorSpy } = vi.hoisted(() => ({ useAuthorSpy: vi.fn(() => ({ data: undefined })) }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: useAuthorSpy }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey: string) => (pubkey.startsWith("78") ? "alex" : "robin"),
  useScopedIdentity: () => ({ displayName: "alex", color: undefined, label: undefined }),
}));

const AUTHOR = "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5";
const OTHER = "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47";
const repository: GitRepositoryAddress = { kind: 30617, owner: AUTHOR, identifier: "armada", coordinate: `30617:${AUTHOR}:armada` };

const BODY = [
  "The channel is unreadable while CI is running.",
  "",
  "![before](https://blossom.example/before.png)",
  "![after](https://blossom.example/after.png)",
  "",
  "https://blossom.example/screen.mp4",
].join("\n");

function ticketWith(content: string, id = "b".repeat(64)): GitTicket {
  return {
    id,
    kind: 1621,
    type: "issue",
    subject: "Git events drown the conversation",
    content,
    labels: [],
    repositoryAddress: repository,
    repositoryAddresses: [repository],
    author: AUTHOR,
    createdAt: 1_785_000_000,
    event: { id, pubkey: AUTHOR, created_at: 1_785_000_000, kind: 1621, content, tags: [] },
  };
}

function commentEntry(ticket: GitTicket, id: string, content: string, createdAt: number): Extract<GitChannelTimelineEntry, { type: "git-comment" }> {
  return {
    type: "git-comment",
    id: `git:${id}`,
    createdAt,
    activity: {
      type: "comment",
      createdAt,
      ticket,
      repository,
      comment: { id, ticketId: ticket.id, ticketKind: 1621, content, author: AUTHOR, createdAt, event: { id, pubkey: AUTHOR, created_at: createdAt, kind: 1111, content, tags: [] } },
    },
  };
}

function statusEntry(ticket: GitTicket, kind: 1630 | 1631 | 1632 | 1633, createdAt: number): Extract<GitChannelTimelineEntry, { type: "git-status" }> {
  const id = `s${kind}${createdAt}`.padEnd(64, "0");
  return {
    type: "git-status",
    id: `git:${id}`,
    createdAt,
    activity: {
      type: "status-change",
      createdAt,
      ticket,
      repository,
      status: { kind, ticketId: ticket.id, author: AUTHOR, createdAt, event: { id, pubkey: AUTHOR, created_at: createdAt, kind, content: "", tags: [["e", ticket.id]] } },
    },
  };
}

describe("an opened ticket", () => {
  const ticket = ticketWith(BODY);
  const entry: GitChannelTimelineEntry = { type: "git-ticket-opened", id: `git:${ticket.id}`, createdAt: ticket.createdAt, activity: { type: "ticket-opened", ticket, repository, createdAt: ticket.createdAt } };

  it("stands in for the body's media rather than playing it in the channel", () => {
    const { container } = render(<GitTimelineRow entry={entry} onOpen={() => {}} />);
    expect(screen.getByText("Git events drown the conversation")).toBeInTheDocument();
    expect(screen.getByText(/The channel is unreadable while CI is running\./)).toBeInTheDocument();
    // Three screenshots and a screen recording is what drowned the channel —
    // and a caption counting them is one more thing competing for the eye.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByText(/image|video/i)).toBeNull();
  });

  it("carries one icon at most: the avatar says who, the words say what", () => {
    const { container } = render(<GitTimelineRow entry={entry} onOpen={() => {}} />);
    expect(container.querySelectorAll("svg")).toHaveLength(0);
    expect(screen.getByText(/opened an issue in armada/)).toBeInTheDocument();
  });

  it("does not date-stamp a row the reading order already places", () => {
    render(<GitTimelineRow entry={entry} onOpen={() => {}} />);
    expect(screen.queryByText(/\d+[mhd]$|^now$/)).toBeNull();
  });

  it("opens the work item from anywhere in the row", () => {
    const onOpen = vi.fn();
    render(<GitTimelineRow entry={entry} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Git events drown the conversation"));
    fireEvent.click(screen.getByText(/The channel is unreadable/));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen.mock.calls[0][0].id).toBe(ticket.id);
  });

  it("offers a way in when the body is longer than the row", () => {
    const long = ticketWith("word ".repeat(200));
    render(<GitTimelineRow entry={{ ...entry, activity: { ...entry.activity, ticket: long } } as GitChannelTimelineEntry} onOpen={() => {}} />);
    expect(screen.getByText("more")).toBeInTheDocument();
  });
});

describe("a burst of comments", () => {
  const ticket = ticketWith("");
  const shown = [
    commentEntry(ticket, "c1".padEnd(64, "0"), "First thought", 1_785_000_100),
    commentEntry(ticket, "c2".padEnd(64, "0"), "Second thought", 1_785_000_101),
  ];

  it("names the ticket once, above the block", () => {
    render(<GitTimelineRow entry={shown[0]} related={shown} onOpen={() => {}} />);
    expect(screen.getAllByText(/Git events drown the conversation/)).toHaveLength(1);
    expect(screen.getByText("First thought")).toBeInTheDocument();
    expect(screen.getByText("Second thought")).toBeInTheDocument();
  });

  it("does not repeat one author's name down the block", () => {
    render(<GitTimelineRow entry={shown[0]} related={shown} onOpen={() => {}} />);
    expect(screen.getAllByText("alex")).toHaveLength(1);
  });

  it("re-introduces the author when the speaker changes", () => {
    const second = commentEntry(ticket, "c2".padEnd(64, "0"), "Second thought", 1_785_000_101);
    second.activity.comment.author = OTHER;
    render(<GitTimelineRow entry={shown[0]} related={[shown[0], second]} onOpen={() => {}} />);
    expect(screen.getByText("alex")).toBeInTheDocument();
    expect(screen.getByText("robin")).toBeInTheDocument();
  });
});

describe("re-rendering", () => {
  const ticket = ticketWith("");
  const group = [
    commentEntry(ticket, "c1".padEnd(64, "0"), "First thought", 1_785_000_100),
    commentEntry(ticket, "c2".padEnd(64, "0"), "Second thought", 1_785_000_101),
  ];
  // The identity the timeline would hold across renders.
  const onOpen = () => {};

  it("stands down when the timeline rebuilds an equal group", () => {
    // One new chat message re-wraps every activity in the window, handing each
    // Git row freshly allocated entries — which must not cost a re-render.
    const rewrapped = group.map((entry) => ({ ...entry }));
    const { rerender } = render(<GitTimelineRow entry={group[0]} related={[...group]} onOpen={onOpen} />);
    const rendered = useAuthorSpy.mock.calls.length;
    expect(rendered).toBeGreaterThan(0);
    rerender(<GitTimelineRow entry={rewrapped[0]} related={rewrapped} onOpen={onOpen} />);
    expect(useAuthorSpy.mock.calls.length).toBe(rendered);
  });

  it("re-renders when the activity itself is rebuilt", () => {
    // A CI run keeps its event id while its Job Results are still arriving, so
    // the row has to follow the activity object rather than the id.
    const { rerender } = render(<GitTimelineRow entry={group[0]} related={[...group]} onOpen={onOpen} />);
    const rendered = useAuthorSpy.mock.calls.length;
    const restated = { ...group[0], activity: { ...group[0].activity } };
    rerender(<GitTimelineRow entry={restated} related={[restated, group[1]]} onOpen={onOpen} />);
    expect(useAuthorSpy.mock.calls.length).toBeGreaterThan(rendered);
  });

  it("re-renders when the group gains an entry", () => {
    const { rerender } = render(<GitTimelineRow entry={group[0]} related={[...group]} onOpen={onOpen} />);
    const rendered = useAuthorSpy.mock.calls.length;
    const third = commentEntry(ticket, "c3".padEnd(64, "0"), "Third thought", 1_785_000_102);
    third.activity.comment.author = OTHER;
    rerender(<GitTimelineRow entry={group[0]} related={[...group, third]} onOpen={onOpen} />);
    expect(useAuthorSpy.mock.calls.length).toBeGreaterThan(rendered);
  });

  it("re-renders when the handler it would call changes", () => {
    const { rerender } = render(<GitTimelineRow entry={group[0]} related={[...group]} onOpen={onOpen} />);
    const rendered = useAuthorSpy.mock.calls.length;
    rerender(<GitTimelineRow entry={group[0]} related={[...group]} onOpen={() => {}} />);
    expect(useAuthorSpy.mock.calls.length).toBeGreaterThan(rendered);
  });
});

describe("tickets filed back to back", () => {
  const entries = ["b", "c", "d"].map((seed, index) => {
    const ticket = ticketWith("body", seed.repeat(64));
    return { type: "git-ticket-opened" as const, id: `git:${ticket.id}`, createdAt: ticket.createdAt + index, activity: { type: "ticket-opened" as const, ticket, repository, createdAt: ticket.createdAt + index } };
  });

  it("introduces the author once and lists what they filed", () => {
    render(<GitTimelineRow entry={entries[0]} related={entries} onOpen={() => {}} />);
    expect(screen.getAllByText("alex")).toHaveLength(1);
    expect(screen.getByText(/opened 3 issues in armada/)).toBeInTheDocument();
    expect(screen.getAllByText("Git events drown the conversation")).toHaveLength(3);
  });

  it("drops the bodies once there is more than one, leaving the subjects", () => {
    render(<GitTimelineRow entry={entries[0]} related={entries} onOpen={() => {}} />);
    expect(screen.queryByText("body")).toBeNull();
  });
});

describe("a ticket that flapped", () => {
  const ticket = ticketWith("");

  it("reports where it ended up, with the churn as a count", () => {
    const changes = [
      statusEntry(ticket, 1632, 1_785_000_200),
      statusEntry(ticket, 1630, 1_785_000_201),
      statusEntry(ticket, 1632, 1_785_000_202),
    ];
    render(<GitTimelineRow entry={changes[0]} related={changes} onOpen={() => {}} />);
    expect(screen.getByText(/closed/)).toBeInTheDocument();
    expect(screen.getByText(/3 status changes/)).toBeInTheDocument();
    expect(screen.queryByText(/reopened/)).not.toBeInTheDocument();
  });

  it("drops the count for a single change", () => {
    const change = statusEntry(ticket, 1631, 1_785_000_200);
    render(<GitTimelineRow entry={change} onOpen={() => {}} />);
    expect(screen.getByText(/resolved/)).toBeInTheDocument();
    expect(screen.queryByText(/status changes/)).not.toBeInTheDocument();
  });
});

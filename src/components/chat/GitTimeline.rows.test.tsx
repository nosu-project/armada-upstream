/**
 * Ticket, comment and status rows. A channel row REFERS to a work item: it
 * stays about the size of a message however large the work item is, and the
 * full thing opens in the panel.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GitTimelineRow } from "@/components/chat/GitTimeline";

import type { GitChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { GitRepositoryAddress, GitTicket, GitTimelineActivity } from "@/lib/gitActivity";

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: () => "alex",
  useScopedIdentity: () => ({ displayName: "alex", color: undefined, label: undefined }),
}));

const AUTHOR = "781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5";
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
    const { container } = render(<GitTimelineRow entry={entry} members={new Set()} onOpen={() => {}} />);
    expect(screen.getByText("Git events drown the conversation")).toBeInTheDocument();
    expect(screen.getByText(/The channel is unreadable while CI is running\./)).toBeInTheDocument();
    expect(screen.getByText("2 images · 1 video")).toBeInTheDocument();
    // Three screenshots and a screen recording is what drowned the channel.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });

  it("opens the work item from anywhere in the row", () => {
    const onOpen = vi.fn();
    render(<GitTimelineRow entry={entry} members={new Set()} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Git events drown the conversation"));
    fireEvent.click(screen.getByText(/The channel is unreadable/));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen.mock.calls[0][0].id).toBe(ticket.id);
  });

  it("offers a way in when the body is longer than the row", () => {
    const long = ticketWith("word ".repeat(200));
    render(<GitTimelineRow entry={{ ...entry, activity: { ...entry.activity, ticket: long } } as GitChannelTimelineEntry} members={new Set()} onOpen={() => {}} />);
    expect(screen.getByText("more")).toBeInTheDocument();
  });
});

describe("a burst of comments", () => {
  const ticket = ticketWith("");
  const shown = [
    commentEntry(ticket, "c1".padEnd(64, "0"), "First thought", 1_785_000_100),
    commentEntry(ticket, "c2".padEnd(64, "0"), "Second thought", 1_785_000_101),
  ];
  const activities: GitTimelineActivity[] = [
    ...shown.map((entry) => entry.activity),
    commentEntry(ticket, "c3".padEnd(64, "0"), "Elsewhere", 1_785_000_300).activity,
    commentEntry(ticket, "c4".padEnd(64, "0"), "Elsewhere too", 1_785_000_400).activity,
  ];

  it("renders one block under the ticket it belongs to", () => {
    render(<GitTimelineRow entry={shown[0]} related={shown} members={new Set()} onOpen={() => {}} activities={activities} />);
    expect(screen.getAllByText("Git events drown the conversation")).toHaveLength(1);
    expect(screen.getByText("First thought")).toBeInTheDocument();
    expect(screen.getByText("Second thought")).toBeInTheDocument();
  });

  it("says how much of the discussion is elsewhere", () => {
    render(<GitTimelineRow entry={shown[0]} related={shown} members={new Set()} onOpen={() => {}} activities={activities} />);
    expect(screen.getByText("View all 4 comments")).toBeInTheDocument();
  });

  it("says nothing when the block is the whole discussion", () => {
    render(<GitTimelineRow entry={shown[0]} related={shown} members={new Set()} onOpen={() => {}} activities={shown.map((entry) => entry.activity)} />);
    expect(screen.queryByText(/View all/)).not.toBeInTheDocument();
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
    render(<GitTimelineRow entry={changes[0]} related={changes} members={new Set()} onOpen={() => {}} />);
    expect(screen.getByText(/closed/)).toBeInTheDocument();
    expect(screen.getByText(/3 status changes/)).toBeInTheDocument();
    expect(screen.queryByText(/reopened/)).not.toBeInTheDocument();
  });

  it("drops the count for a single change", () => {
    const change = statusEntry(ticket, 1631, 1_785_000_200);
    render(<GitTimelineRow entry={change} members={new Set()} onOpen={() => {}} />);
    expect(screen.getByText(/resolved/)).toBeInTheDocument();
    expect(screen.queryByText(/status changes/)).not.toBeInTheDocument();
  });
});

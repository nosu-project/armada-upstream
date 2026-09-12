/**
 * The forum feed is one flat surface of rows, not a stack of cards: pinned
 * posts grouped first under their own eyebrow, unseen activity as the app's
 * new-dot, the comment count as plain text, and the sort as the shared
 * pill tabs. These pin the shape a later "polish" is most likely to drift from.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ForumFeed } from "@/concord/components/ForumFeed";

import type { ChatMsg } from "@/components/chat/transport";
import type { ForumPost } from "@/concord/lib/forum";

// Profiles come from the relay pool; the feed only needs a name per pubkey.
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey: string) => `user-${pubkey.slice(0, 2)}`,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ pubkey }: { pubkey: string }) => <span>user-{pubkey.slice(0, 2)}</span>,
}));

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

const ANA = "a".repeat(64);
const BEN = "b".repeat(64);
const NOW = 1_800_000_000;

function post(id: string, title: string, opts: Partial<ForumPost> & { pubkey?: string; createdAt?: number } = {}): ForumPost {
  const root = {
    id,
    pubkey: opts.pubkey ?? ANA,
    created_at: opts.createdAt ?? NOW,
    kind: 9,
    content: "body",
    tags: [["subject", title]],
    sig: "",
  } as unknown as ChatMsg;
  return {
    root,
    title,
    replyCount: opts.replyCount ?? 0,
    lastActivityAt: opts.lastActivityAt ?? root.created_at,
    lastActivityBy: opts.lastActivityBy ?? root.pubkey,
    participants: opts.participants ?? [],
    pinned: opts.pinned ?? false,
  };
}

function renderFeed(posts: ForumPost[], overrides: Partial<Parameters<typeof ForumFeed>[0]> = {}) {
  const onOpen = vi.fn();
  const onSortChange = vi.fn();
  render(
    <ForumFeed
      posts={posts}
      sort="active"
      onSortChange={onSortChange}
      isLoading={false}
      onOpen={onOpen}
      isNew={() => false}
      {...overrides}
    />,
  );
  return { onOpen, onSortChange };
}

describe("ForumFeed — rows on one surface", () => {
  it("lists every post as a row with its title, author and comment count, and opens it on click", () => {
    const { onOpen } = renderFeed([
      post("p1", "Release notes", { replyCount: 4, participants: [BEN] }),
      post("p2", "Hello", { pubkey: BEN }),
    ]);

    const rows = screen.getAllByRole("button", { name: /Release notes|Hello/ });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Release notes")).toBeInTheDocument();
    expect(within(rows[0]).getByText("user-aa")).toBeInTheDocument();
    expect(within(rows[0]).getByText("4")).toBeInTheDocument();
    expect(within(rows[1]).getByText("0")).toBeInTheDocument();

    fireEvent.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "Hello" }));
  });

  it("groups pinned posts first under a Pinned eyebrow, and the rest under Posts", () => {
    renderFeed([
      post("p1", "Read me first", { pinned: true }),
      post("p2", "Regular"),
    ]);

    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("Posts")).toBeInTheDocument();
    const titles = screen.getAllByRole("button", { name: /Read me first|Regular/ }).map((b) => b.textContent);
    expect(titles[0]).toContain("Read me first");
    expect(titles[1]).toContain("Regular");
  });

  it("has no group eyebrows when nothing is pinned", () => {
    renderFeed([post("p1", "Only")]);
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(screen.queryByText("Posts")).not.toBeInTheDocument();
  });

  it("marks unseen activity with the new-dot, not a border", () => {
    renderFeed([post("p1", "Fresh"), post("p2", "Seen")], { isNew: (p) => p.root.id === "p1" });
    const fresh = screen.getByRole("button", { name: /Fresh/ });
    const seen = screen.getByRole("button", { name: /Seen/ });
    expect(within(fresh).getByLabelText("New activity")).toBeInTheDocument();
    expect(within(seen).queryByLabelText("New activity")).not.toBeInTheDocument();
    expect(fresh.className).not.toMatch(/border-l/);
  });

  it("sorts through the shared pill tabs", () => {
    const { onSortChange } = renderFeed([post("p1", "A")]);
    const active = screen.getByRole("button", { name: "Active" });
    expect(active).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Newest" }));
    expect(onSortChange).toHaveBeenCalledWith("newest");
  });

  it("offers New post only to writers, and the empty state names the first one", () => {
    renderFeed([]);
    expect(screen.getByText("No posts yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New post/ })).not.toBeInTheDocument();

    const onNewPost = vi.fn();
    renderFeed([], { onNewPost });
    fireEvent.click(screen.getByRole("button", { name: /Write the first post/ }));
    expect(onNewPost).toHaveBeenCalled();
  });

  it("reads an empty feed as catching up while a sync is running, without a call to write", () => {
    renderFeed([], { syncing: true, onNewPost: vi.fn() });
    expect(screen.getByText("Catching up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Write the first post/ })).not.toBeInTheDocument();
  });
});

describe("ForumFeed — paging older history", () => {
  function observable() {
    // An IntersectionObserver the test can fire: the latest instance's
    // callback, with the sentinel reported in view.
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const intersect = () => {
      const cb = callbacks[callbacks.length - 1];
      cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    };
    return { intersect };
  }

  it("pulls a bounded number of pages on its own, then leaves the rest to the button", async () => {
    const { intersect } = observable();
    const onLoadOlder = vi.fn(async () => 0);
    renderFeed([post("p1", "Only")], { hasMore: true, onLoadOlder });

    // A page that adds no post leaves the sentinel in view, so the observer
    // keeps reporting it; the feed must not follow it through the whole history.
    for (let i = 0; i < 20; i++) intersect();
    expect(onLoadOlder).toHaveBeenCalledTimes(8);

    // The reader asking is a different matter: the button still works, and
    // grants the sentinel another run.
    fireEvent.click(screen.getByRole("button", { name: /Load older posts/ }));
    expect(onLoadOlder).toHaveBeenCalledTimes(9);
    intersect();
    expect(onLoadOlder).toHaveBeenCalledTimes(10);
  });
});

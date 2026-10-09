import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A Concord invite mid-sentence stays an inline link where it was written, and
 * its card follows the message text, so the Join affordance is never lost to
 * the end-of-line rule that keeps link previews from splitting a sentence.
 */

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({
  useMentionNameMap: () => ({ byName: new Map(), regex: null }),
}));
vi.mock("@/hooks/useCustomEmojis", () => ({
  useCustomEmojis: () => ({ emojis: [], isLoading: false }),
}));
vi.mock("@/components/chat/InviteEmbed", () => ({
  InviteEmbed: ({ url }: { url: string }) => <div data-testid="invite-card" data-url={url} />,
}));

import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

let nextId = 0;

function message(content: string): NostrEvent {
  return {
    id: (nextId++).toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    created_at: 1700000000,
    kind: 9,
    tags: [],
    content,
    sig: "0".repeat(128),
  };
}

function renderContent(content: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatContent event={message(content)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const INVITE =
  "https://poster.place/invite/naddr1qvzqqqyzz5pzq3hjhx37t4u9uw5gthnmm3v62q3a5tqfxxqkze640quspp5rydekqqqqxw75uz#BAADAQIDAfAUHIPFIc91LplzbDY0bg";

function cards(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-testid=invite-card]")).map(
    (el) => el.getAttribute("data-url") ?? "",
  );
}

describe("ChatContent invites", () => {
  it("cards a mid-sentence invite after the text and keeps the inline link", () => {
    const { container } = renderContent(`almost, join room ${INVITE} so we can sort this out`);
    expect(cards(container)).toEqual([INVITE]);
    expect(container.textContent).toContain("so we can sort this out");
    const link = container.querySelector("a")!;
    expect(link).not.toBeNull();
    // The card comes after the inline link, not in its place.
    const card = container.querySelector("[data-testid=invite-card]")!;
    expect(link.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cards an end-of-line invite in place, once", () => {
    const { container } = renderContent(`see ${INVITE} here\n${INVITE}`);
    expect(cards(container)).toEqual([INVITE]);
  });
});

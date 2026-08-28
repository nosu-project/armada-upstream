import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The RENDER half of own-origin links: that a link back into this app becomes
 * an in-app destination rather than an external website. `selfLink.test.ts`
 * covers which URLs qualify; this covers what the renderer does with them,
 * which is the part the bug was about — a `target="_blank"` anchor carrying
 * the full URL, for a location the router already knows.
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
// A mention chip wraps itself in the profile popover, which reaches for the
// Nostr pool on mount. Only the chip itself is under test here.
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

const NPUB = "npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p";
const MSG = "9eb8fee9fc77aad33f7957bee461417b882b565958ada1f8f1d3bdccfe1e7da8";
const DM_URL = `https://armada.buzz/dm/${NPUB}/m/${MSG}`;

let nextId = 0;

/** A minimal kind-9 carrying `content`, with an id unique per call so the
 *  module-level token cache never answers for another test's body. */
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

/** Every rendered anchor as `[href, target]`. */
function anchors(container: HTMLElement): [string, string][] {
  return Array.from(container.querySelectorAll("a")).map((a) => [
    a.getAttribute("href") ?? "",
    a.getAttribute("target") ?? "",
  ]);
}

describe("ChatContent own-origin links", () => {
  it("routes a mid-sentence message link internally", () => {
    const { container } = renderContent(`look at ${DM_URL} for context`);
    // A router <Link> resolves to the path alone, and never opens a new tab.
    expect(anchors(container)).toEqual([[`/dm/${NPUB}/m/${MSG}`, ""]]);
  });

  it("keeps the full URL available on the link's title", () => {
    const { container } = renderContent(`look at ${DM_URL} for context`);
    expect(container.querySelector("a")?.getAttribute("title")).toBe(DM_URL);
  });

  it("renders an end-of-line message link as an in-app card", () => {
    const { container } = renderContent(DM_URL);
    // The card is a role="link" div that navigates — no external anchor at all.
    expect(anchors(container)).toEqual([]);
    expect(container.querySelector('[role="link"]')?.getAttribute("title")).toBe(DM_URL);
    expect(container.textContent).toContain("Direct message");
  });

  it("labels a community channel card by what the path names", () => {
    const { container } = renderContent("https://armada.buzz/c/abc123/general");
    expect(container.textContent).toContain("Community channel");
  });

  it("reads a bare profile link as a mention rather than a link", () => {
    const { container } = renderContent(`hi ${`https://armada.buzz/${NPUB}`} there`);
    expect(anchors(container)).toEqual([]);
    expect(container.textContent).not.toContain("armada.buzz");
  });

  it("leaves the same path shape on another host external", () => {
    // The path alone means nothing — only the origin makes a link ours.
    const { container } = renderContent("see https://example.com/c/abc123/general here");
    expect(anchors(container)).toEqual([
      ["https://example.com/c/abc123/general", "_blank"],
    ]);
  });

  it("leaves an own-origin path that names no chat location external", () => {
    const { container } = renderContent("see https://armada.buzz/settings here");
    expect(anchors(container)).toEqual([["https://armada.buzz/settings", "_blank"]]);
  });
});

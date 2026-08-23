import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Chat's Discord-flavored block markdown, end to end through ChatContent:
 * headings and lists render as such without the document flag, the deeper
 * heading levels stay document-only, and a fenced block with a language comes
 * out highlighted.
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

import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

let nextId = 0;

/** A minimal kind-9 carrying `content`, with an id unique per call so the
 *  module-level token cache never answers for another test's body. */
function message(content: string): NostrEvent {
  return {
    id: (nextId++).toString(16).padStart(64, "0"),
    pubkey: "b".repeat(64),
    created_at: 1700000000,
    kind: 9,
    tags: [],
    content,
    sig: "0".repeat(128),
  };
}

function renderContent(content: string, documentMarkdown = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatContent event={message(content)} documentMarkdown={documentMarkdown} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatContent chat markdown", () => {
  it("renders # / ## / ### headings in a chat message", () => {
    const { container } = renderContent("# Title\n## Subtitle\n### Section\nbody **bold**");
    const headings = Array.from(container.querySelectorAll('[role="heading"]'));
    expect(headings.map((h) => h.getAttribute("aria-level"))).toEqual(["1", "2", "3"]);
    expect(headings.map((h) => h.textContent)).toEqual(["Title", "Subtitle", "Section"]);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("keeps a level-4 heading literal in chat and renders it in document mode", () => {
    const chat = renderContent("#### deep");
    expect(chat.container.querySelector('[role="heading"]')).toBeNull();
    expect(chat.container.textContent).toContain("#### deep");
    cleanup();
    const doc = renderContent("#### deep", true);
    expect(doc.container.querySelector('[role="heading"]')?.getAttribute("aria-level")).toBe("4");
  });

  it("renders bullet and numbered lists in a chat message", () => {
    const { container } = renderContent("- one\n- two\n\n1. first\n2. second");
    expect(Array.from(container.querySelectorAll("ul > li")).map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(Array.from(container.querySelectorAll("ol > li")).map((li) => li.textContent)).toEqual(["first", "second"]);
  });

  it("leaves a hashtag alone", () => {
    const { container } = renderContent("#nostr is neat");
    expect(container.querySelector('[role="heading"]')).toBeNull();
    expect(container.textContent).toContain("#nostr is neat");
  });

  it("highlights a fenced block that names a language", async () => {
    const { container } = renderContent('```json\n{"name": "Eduardo"}\n```');
    const pre = container.querySelector("pre");
    expect(pre?.dataset.lang).toBe("json");
    await waitFor(() => expect(pre?.querySelector(".hljs-attr")).not.toBeNull());
    expect(pre?.textContent).toBe('{"name": "Eduardo"}');
  });
});

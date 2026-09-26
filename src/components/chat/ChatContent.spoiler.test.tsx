import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A spoilered image is reachable only through its cover: the image button
 * underneath is out of the tab order and inert until revealed, and the
 * sender's description of what it hides is not exposed while it is covered.
 */

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useApps", () => ({
  useApps: () => ({ activeApp: null, launchApp: () => {} }),
}));
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

function message(content: string, tags: string[][]): NostrEvent {
  return {
    id: "5".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1700000000,
    kind: 9,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

const IMAGE = "https://blossom.example.com/cat.jpg";

describe("ChatContent spoilered image", () => {
  it("keeps the image behind its cover until revealed", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ChatContent
            event={message(IMAGE, [["imeta", `url ${IMAGE}`, "m image/jpeg", "alt the ending", "content-warning spoiler"]])}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const cover = screen.getByRole("button", { name: "Reveal spoiler" });
    const imageButton = cover.closest("button")!;
    expect(imageButton.tabIndex).toBe(-1);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("title")).toBeNull();
    expect(container.textContent).not.toContain("the ending");

    fireEvent.click(cover);
    expect(screen.queryByRole("button", { name: "Reveal spoiler" })).toBeNull();
    expect(imageButton.tabIndex).toBe(0);
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("the ending");
  });
});

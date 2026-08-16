import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { AppConfig, AppContextType } from "@/contexts/AppContext";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The VIEW half of link canonicalization: that the renderer strips tracking
 * parameters from a URL before it reaches an `href`, and that the setting
 * actually turns it off. `trackingParams.test.ts` covers which parameters go;
 * this covers the wiring, which is the part that can silently come undone.
 *
 * Links are kept mid-sentence on purpose — a URL alone on a line tokenizes as a
 * `link-embed`, which mounts the preview card and would fetch.
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

import { AppContext, defaultConfig } from "@/contexts/AppContext";
import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

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

function renderContent(content: string, config?: Partial<AppConfig>) {
  const wrap = (children: ReactNode) =>
    config
      ? (
        <AppContext.Provider
          value={
            {
              config: { ...defaultConfig, ...config },
              updateConfig: () => {},
            } as unknown as AppContextType
          }
        >
          {children}
        </AppContext.Provider>
      )
      : children;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{wrap(<ChatContent event={message(content)} />)}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The `href`s of every rendered link, in order. */
function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("ChatContent link canonicalization", () => {
  it("strips a YouTube share id from a rendered link", () => {
    const { container } = renderContent("watch https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH now");
    expect(hrefs(container)).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
  });

  it("strips campaign tags while keeping the rest of the query", () => {
    const { container } = renderContent(
      "see https://example.com/post?id=7&utm_source=news&utm_medium=email here",
    );
    expect(hrefs(container)).toEqual(["https://example.com/post?id=7"]);
  });

  it("leaves an untracked link untouched", () => {
    const { container } = renderContent("see https://example.com/post?id=7 here");
    expect(hrefs(container)).toEqual(["https://example.com/post?id=7"]);
  });

  it("renders the URL as it arrived when the setting is off", () => {
    const { container } = renderContent(
      "watch https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH now",
      { stripTrackingParams: false },
    );
    expect(hrefs(container)).toEqual(["https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH"]);
  });

  it("keeps the surrounding text and the sentence's punctuation", () => {
    const { container } = renderContent("watch https://youtu.be/abc12345678?si=xy, then reply");
    expect(container.textContent).toContain("watch ");
    expect(container.textContent).toContain(", then reply");
    expect(hrefs(container)).toEqual(["https://youtu.be/abc12345678"]);
  });

  it("defaults to stripping when mounted without an AppProvider", () => {
    const { container } = renderContent("watch https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH now");
    expect(hrefs(container)).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
  });
});

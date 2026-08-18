import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A webxdc Mini App attachment renders as a launch card regardless of which
 * client sent it. Armada writes `application/x-webxdc`; Vector writes
 * `application/vnd.webxdc+zip` and uploads AES-GCM ciphertext to Blossom, so
 * the URL is extension-less and lives ONLY in the imeta tag. The read side
 * accepts both MIME spellings; without that a Vector Mini App arrived as a
 * generic download card instead of a launch card.
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

let nextId = 0;

/** A minimal kind-9 chat message, with an id unique per call so the
 *  module-level token cache never answers for another test's body. */
function message(content: string, tags: string[][]): NostrEvent {
  return {
    id: (nextId++).toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    created_at: 1700000000,
    kind: 9,
    tags,
    content,
    sig: "0".repeat(128),
  };
}

function renderMessage(content: string, tags: string[][]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatContent event={message(content, tags)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const BLOB = "https://blossom.example.com/2b3c4d5e6f";

describe("ChatContent webxdc attachments", () => {
  it("renders a Vector application/vnd.webxdc+zip attachment as a launch card", () => {
    const { container } = renderMessage("", [
      [
        "imeta",
        `url ${BLOB}`,
        "m application/vnd.webxdc+zip",
        "summary Checkers",
        "encryption-algorithm aes-gcm",
        `decryption-key ${"1".repeat(64)}`,
        `decryption-nonce ${"2".repeat(32)}`,
      ],
    ]);
    // The launch card, not a generic file-embed.
    expect(container.textContent).toContain("Webxdc app");
    expect(container.textContent).toContain("Checkers");
    // No chat scope in the test → the card offers a Download link to the blob.
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(BLOB);
  });

  it("still renders Armada's own application/x-webxdc attachment as a launch card", () => {
    const { container } = renderMessage("", [
      [
        "imeta",
        `url ${BLOB}`,
        "m application/x-webxdc",
        "summary Snake",
        "webxdc 11111111-2222-3333-4444-555555555555",
      ],
    ]);
    expect(container.textContent).toContain("Webxdc app");
    expect(container.textContent).toContain("Snake");
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(BLOB);
  });
});

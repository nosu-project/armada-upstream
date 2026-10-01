import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A held author's media is not in the DOM at all — no <img>, no <video>, no
 * blurhash, no sender emoji — until the reader presses Load.
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
vi.mock("@/components/BlurhashCanvas", () => ({ BlurhashCanvas: () => <canvas /> }));
vi.mock("@/hooks/useCustomEmojis", () => ({
  useCustomEmojis: () => ({ emojis: [], isLoading: false }),
}));

import { ChatContent } from "@/components/chat/ChatContent";
import { MediaHoldContext } from "@/components/chat/mediaHold";

afterEach(cleanup);

const STRANGER = "f".repeat(64);
const IMAGE = "https://blossom.example.com/x.jpg";
const EMOJI = "https://emoji.example.com/e.png";

function message(): NostrEvent {
  return {
    id: "6".repeat(64),
    pubkey: STRANGER,
    created_at: 1700000000,
    kind: 9,
    tags: [
      ["imeta", `url ${IMAGE}`, "m image/jpeg", "blurhash LEHV6nWB2yk8pyo0adR*.7kCMdnj"],
      ["emoji", "wave", EMOJI],
    ],
    content: `:wave: ${IMAGE}`,
    sig: "0".repeat(128),
  };
}

function renderWith(holds: ((pubkey: string) => boolean) | null) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MediaHoldContext.Provider value={holds}>
          <ChatContent event={message()} />
        </MediaHoldContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatContent media hold", () => {
  it("renders nothing fetchable for a held author until Load", () => {
    const { container } = renderWith((pk) => pk === STRANGER);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByText("Image not loaded")).toBeInTheDocument();
    expect(container.textContent).toContain(":wave:");

    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.queryByText("Image not loaded")).toBeNull();
    expect(container.querySelector(`img[src="${EMOJI}"]`)).not.toBeNull();
  });

  it("is a no-op without a provider", () => {
    renderWith(null);
    expect(screen.queryByText("Image not loaded")).toBeNull();
  });
});

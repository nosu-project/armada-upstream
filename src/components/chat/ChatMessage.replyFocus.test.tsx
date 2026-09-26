import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";

/**
 * Reply from the right-click menu must land the caret in the composer. Radix
 * flushes an item's onSelect while the menu still traps focus, so a composer
 * that focuses in the same commit is pulled straight back into the menu. (The
 * menu's later focus-restore, which `keepActionFocus` suppresses, runs after
 * its exit animation — jsdom has none, so that half isn't observable here.)
 */

vi.mock("@/hooks/useIsMobile", () => ({
  useIsTouch: () => false,
  useIsMobile: () => false,
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>(), ready: true }),
  useMuteToggle: () => ({
    muted: false,
    canMute: false,
    pending: false,
    label: "Mute",
    toggle: async () => {},
  }),
}));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({
  useMentionNameMap: () => ({ byName: new Map(), regex: null }),
}));
vi.mock("@/hooks/useCustomEmojis", () => ({ useCustomEmojis: () => ({ emojis: [], isLoading: false }) }));
vi.mock("@/hooks/useResolvedMediaSrc", () => ({ useResolvedMediaSrc: () => ({ src: undefined }) }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name}</span>,
}));

import { ChatMessage } from "@/components/chat/ChatMessage";

const event = {
  id: "f".repeat(64),
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 9,
  content: "hello there",
  tags: [],
} as ChatMsg;

afterEach(cleanup);

/** The page's reply state plus ChatComposer's focus-on-reply effect, as written there. */
function Harness() {
  const [replyTo, setReplyTo] = useState<ChatMsg | undefined>();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!replyTo) return;
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [replyTo]);
  return (
    <>
      <ChatMessage event={event} canWrite canModerate={false} onReply={setReplyTo} />
      <textarea id="composer" ref={ref} />
    </>
  );
}

describe("ChatMessage context-menu Reply", () => {
  it("keeps focus on the composer after the menu closes", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.contextMenu(screen.getByText("hello there"));
    const item = await screen.findByRole("menuitem", { name: /reply/i });
    fireEvent.click(item);
    // Radix restores focus on a timer after the content unmounts.
    await act(() => new Promise((r) => setTimeout(r, 50)));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement?.id).toBe("composer");
  });
});

import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";

/**
 * Verifies the effect of not mounting the right-click ContextMenu on touch
 * (ChatMessage.tsx): the touch long-press sheet already owns message actions,
 * so the per-row Radix ContextMenu root is pure weight there. Fewer DOM nodes
 * per row on touch is the observable proof the root was dropped; desktop keeps
 * it (the control below).
 */

const touch = { value: false };
vi.mock("@/hooks/useIsMobile", () => ({
  useIsTouch: () => touch.value,
  useIsMobile: () => false,
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
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

function renderRow() {
  // onReply gives the row a menu action, so the desktop ContextMenu has content.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatMessage event={event} canWrite canModerate={false} onReply={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("ChatMessage ContextMenu is desktop-only", () => {
  it("mounts fewer DOM nodes on touch (no ContextMenu root) than on desktop", () => {
    touch.value = false;
    const desktop = renderRow();
    const desktopNodes = desktop.container.querySelectorAll("*").length;
    cleanup();

    touch.value = true;
    const mobile = renderRow();
    const touchNodes = mobile.container.querySelectorAll("*").length;

    // Same message body on both, so any delta is the dropped ContextMenu
    // subtree (trigger wrapper + Radix plumbing).
    expect(touchNodes).toBeLessThan(desktopNodes);
    // The body still renders on touch.
    expect(mobile.container.textContent).toContain("hello there");
  });
});

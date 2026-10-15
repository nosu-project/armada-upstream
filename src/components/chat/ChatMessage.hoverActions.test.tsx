import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";

/** `messageHoverActions` off drops the desktop hover strip; the right-click menu stays. */

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
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppContext, defaultConfig } from "@/contexts/AppContext";

const event = {
  id: "f".repeat(64),
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 9,
  content: "hello there",
  tags: [],
} as ChatMsg;

function renderRow(messageHoverActions: boolean) {
  const view = render(
    <AppContext.Provider value={{ config: { ...defaultConfig, messageHoverActions }, updateConfig: () => {} }}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TooltipProvider>
            <ChatMessage event={event} canWrite canModerate={false} onReply={() => {}} />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </AppContext.Provider>,
  );
  fireEvent.pointerEnter(view.container.querySelector(`[data-event-id="${event.id}"]`)!);
  return view;
}

afterEach(cleanup);

describe("ChatMessage hover actions setting", () => {
  it("shows the hover strip by default", () => {
    renderRow(true);
    expect(screen.queryByRole("button", { name: "Reply" })).not.toBeNull();
  });

  it("omits the hover strip when turned off", () => {
    renderRow(false);
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(screen.getByText("hello there")).toBeTruthy();
  });
});

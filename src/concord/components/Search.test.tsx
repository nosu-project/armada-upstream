import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";
import type { Channel } from "@/concord/lib/types";

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
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: () => Promise.resolve() }));

import { SearchResultsView } from "@/concord/components/Search";

const CHANNEL = "c".repeat(64);

const message = {
  id: "f".repeat(64),
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 9,
  content: "hello there",
  tags: [["channel", CHANNEL]],
} as ChatMsg;

const channels = [{ idHex: CHANNEL, name: "general", isPrivate: false }] as unknown as Channel[];

afterEach(cleanup);

function renderResults(onJump: (channelIdHex: string, message: ChatMsg) => void, list = channels) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SearchResultsView channels={list} results={[message]} isLoading={false} query="" onJump={onJump} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMenu() {
  fireEvent.contextMenu(screen.getByText("hello there"));
  return screen.findByRole("menu");
}

describe("SearchResultsView", () => {
  it("jumps once from the context menu's Jump to message", async () => {
    const onJump = vi.fn();
    renderResults(onJump);

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /jump to message/i }));
    await act(() => new Promise((r) => setTimeout(r, 0)));

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(CHANNEL, message);
  });

  it("does not jump when another menu action is chosen", async () => {
    const onJump = vi.fn();
    renderResults(onJump);

    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /copy text/i }));
    await act(() => new Promise((r) => setTimeout(r, 0)));

    expect(onJump).not.toHaveBeenCalled();
  });

  it("still jumps on a plain click of the row", () => {
    const onJump = vi.fn();
    renderResults(onJump);

    fireEvent.click(screen.getByText("hello there"));

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("offers no jump when the channel is unknown", async () => {
    renderResults(vi.fn(), []);

    await openMenu();
    expect(screen.queryByRole("menuitem", { name: /jump to message/i })).toBeNull();
  });
});

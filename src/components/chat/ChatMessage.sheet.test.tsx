import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { ChatMsg } from "@/components/chat/transport";

/**
 * The touch long-press → action sheet wiring on a message row.
 *
 * Scope note: jsdom cannot exercise the DISMISS half of this. Radix defers a
 * touch outside-dismiss to the click that follows the outside pointerdown, and
 * under `disableOutsidePointerEvents` that chain doesn't complete here — a
 * synthetic outside tap leaves the sheet open. So anything about reopening
 * after a dismiss has to be verified on a device, not asserted here.
 */

// jsdom ships no PointerEvent, so `pointerType` never reaches the handlers and
// every touch gesture reads as a non-touch one. Enough of it to carry the field.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
    this.pointerId = init.pointerId ?? 1;
  }
}
window.PointerEvent = TestPointerEvent as unknown as typeof window.PointerEvent;

vi.mock("@/hooks/useIsMobile", () => ({
  useIsTouch: () => true,
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
import { LONG_PRESS_MS } from "@/hooks/useLongPress";

const event = {
  id: "f".repeat(64),
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 9,
  content: "hello there",
  tags: [],
} as ChatMsg;

function renderRow() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatMessage event={event} canWrite canModerate={false} onReply={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = () => document.querySelector(`[data-event-id="${event.id}"]`)!;

/** Press and hold the message row until the long press fires, then release. */
function longPressRow() {
  fireEvent.pointerDown(row(), { pointerType: "touch", clientX: 10, clientY: 10 });
  act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
  fireEvent.pointerUp(row(), { pointerType: "touch", clientX: 10, clientY: 10 });
}

const sheetShowing = () => screen.queryAllByText("Reply").length > 0;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("message action sheet", () => {
  it("opens on a touch long-press of the row", () => {
    renderRow();
    expect(sheetShowing()).toBe(false);

    longPressRow();

    expect(sheetShowing()).toBe(true);
    // The row is picked out behind the sheet.
    expect(row().className).toContain("bg-secondary/40");
  });

  it("does not open before the hold completes", () => {
    renderRow();

    fireEvent.pointerDown(row(), { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS - 50));

    expect(sheetShowing()).toBe(false);
  });
});

import { act, cleanup, render } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ReactNode } from "react";

/**
 * Verifies the viewport gating on the /dm conversation list against the REAL
 * ConversationList — rendering the component the page renders, not a stand-in.
 *
 * The report this exists for was that a 32-conversation inbox still mounted
 * every row. The whole hook stack around the list is stubbed so the assertion
 * is about which rows MOUNT and nothing else.
 */

const spies = vi.hoisted(() => ({ useAuthor: vi.fn(), useLivekitParticipants: vi.fn() }));

vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => {
    spies.useAuthor(pubkey);
    return { data: undefined };
  },
}));
vi.mock("@/hooks/useLivekit", () => ({
  useDmVoiceRelay: () => ({ data: undefined }),
  useLivekitParticipants: (relay?: string, room?: string) => {
    spies.useLivekitParticipants(relay, room);
    return { data: [] };
  },
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "f".repeat(64) } }),
}));
vi.mock("@/hooks/useReadState", () => ({
  useReadState: () => ({ getLastRead: () => 0, markRead: () => {} }),
  dmReadKey: (peer: string) => `dm:${peer}`,
}));
vi.mock("@/hooks/useCall", () => ({
  useCall: () => ({ registerCallBarSlot: () => () => {}, activeCall: undefined }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      showDmRequests: true,
      useAppDmRelays: false,
      useOwnDmRelays: false,
      appRelays: [],
      dmRelays: [],
    },
  }),
}));
vi.mock("@/hooks/useMuteList", () => ({
  useMuteUser: () => ({ mutateAsync: async () => {} }),
  useMuteToggle: () => ({ muted: false, canMute: false, pending: false, label: "Mute", toggle: async () => {} }),
}));
vi.mock("@/hooks/useToast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/hooks/useSharedCommunities", () => ({ useSharedCommunities: () => new Map() }));
vi.mock("@/hooks/useDmMessageSearch", () => ({ useDmMessageSearch: () => new Map() }));
// Composes the row's title from every participant's profile, which means a
// query client and the profile sync topic. The names are not what this file
// asserts on, so it takes the same stub treatment as the rest of the stack.
vi.mock("@/hooks/useDmConversationName", () => ({
  useDmConversationName: (peers: string[]) => ({
    name: peers.join(", "),
    names: peers,
    metadata: undefined,
  }),
}));
vi.mock("@/hooks/usePinnedDms", () => ({
  usePinnedDms: () => ({ pinned: [], isPinned: () => false, togglePin: () => {} }),
}));
vi.mock("@/hooks/useRailDms", () => ({
  useRailDms: () => ({ isOnRail: () => false, toggleRail: () => {} }),
}));
vi.mock("@/hooks/useDm17", () => ({
  useDm17Backfill: () => ({ hasMore: false, isLoading: false, loadOlder: async () => [] }),
  useDm17Conversations: () => ({ rows: [], isLoading: false }),
  useDm17Support: () => true,
  useAdoptDmInbox: () => {},
}));
vi.mock("@/components/auth/LoginArea", () => ({ LoginArea: () => null }));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name}</span>,
}));
vi.mock("@/components/BotPill", () => ({ BotPill: () => null }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { ConversationList } from "@/pages/DMsPage";

// Controllable IntersectionObserver: nothing intersects until a test says so.
const observers: MockIO[] = [];
class MockIO {
  els = new Set<Element>();
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.els.add(el);
  }
  unobserve(el: Element) {
    this.els.delete(el);
  }
  disconnect() {
    this.els.clear();
  }
  takeRecords() {
    return [];
  }
  fire() {
    const entries = [...this.els].map(
      (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
    );
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}

function fireAll() {
  act(() => {
    for (const io of [...observers]) io.fire();
  });
}

function conversations(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const peer = getPublicKey(generateSecretKey());
    return {
      conversation: peer,
      peers: [peer],
      latest: {
        id: `${i}`,
        pubkey: peer,
        created_at: 1_700_000_000 - i,
        kind: 4,
        content: "",
        tags: [],
      } as NostrRumor,
      plaintext: `message ${i}`,
      mine: false,
    };
  });
}

/** Mounted conversation rows (each ConversationRow renders one button). */
function rowCount(container: HTMLElement): number {
  return container.querySelectorAll("button.rounded-lg").length;
}

/** Unmounted rows still showing their spacer. */
function placeholderCount(container: HTMLElement): number {
  return [...container.querySelectorAll("div[aria-hidden]")].filter(
    (el) => (el as HTMLElement).style.height === "68px",
  ).length;
}

function list(rows: ReturnType<typeof conversations>, extra?: Record<string, unknown>): ReactNode {
  return (
    <TooltipProvider>
    <ConversationList
      rows={rows}
      requestRows={[]}
      view="inbox"
      onViewChange={() => {}}
      previews={{}}
      events={[]}
      activePeer={undefined}
      dmSupported
      isLoading={false}
      hasUnread={false}
      onMarkAllRead={() => {}}
      onCompose={() => {}}
      openPeer={() => {}}
      closePeer={() => {}}
      loadMore={async () => 0}
      hasMore={false}
      isLoadingMore={false}
      {...extra}
    />
    </TooltipProvider>
  );
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIO);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ConversationList viewport gating", () => {
  it("gates rows past the first screenful on a 32-conversation inbox", () => {
    const { container } = render(list(conversations(32)));

    // EAGER_ROWS = 12 render immediately; the remaining 20 are placeholders,
    // each holding open the row's height so the scrollbar doesn't lie.
    expect(rowCount(container)).toBe(12);
    expect(placeholderCount(container)).toBe(20);
    expect(observers.length).toBe(20);
    // Only the mounted rows stood up per-row queries.
    expect(spies.useAuthor).toHaveBeenCalledTimes(12);

    // Scrolling them into view mounts them; no row is lost.
    fireAll();
    expect(rowCount(container)).toBe(32);
    expect(placeholderCount(container)).toBe(0);
  });

  it("mounts every row when the list is shorter than the eager window", () => {
    const { container } = render(list(conversations(8)));

    expect(rowCount(container)).toBe(8);
    expect(observers.length).toBe(0);
  });

  it("gates the request tier by position too", () => {
    const requestRows = conversations(30);
    const { container } = render(
      list([], { requestRows, view: "requests" }),
    );

    expect(rowCount(container)).toBe(12);
    expect(placeholderCount(container)).toBe(18);
  });
});

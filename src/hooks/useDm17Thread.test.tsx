import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenedDm } from "@/lib/nip17/protocol";
import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const RELAY = "wss://dm.test";

const h = vi.hoisted(() => ({
  self: "",
  peer: "",
  rows: [] as OpenedDm[],
  relayEvents: [] as NostrEvent[],
  openedByWrap: new Map<string, OpenedDm>(),
  queryLimits: [] as number[],
  scope: 0,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({ query: async () => h.relayEvents }),
      group: () => ({ event: async () => undefined }),
    },
  }),
}));

vi.mock("@/contexts/AppContext", () => ({
  effectiveDmRelays: () => [RELAY],
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: {} }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: h.self,
      method: "nsec",
      signer: {
        nip44: {
          encrypt: async () => "ciphertext",
          decrypt: async () => "plaintext",
        },
      },
    },
  }),
}));

vi.mock("@/hooks/useDecryptConsent", () => ({
  useDecryptConsent: () => ({ consent: "allowed", declined: false }),
}));

vi.mock("@/hooks/useDmRelayList", () => ({
  useDmRelayList: () => ({ relays: [], hasList: false, isLoading: false }),
  useDmRelaysForAll: () => new Map(),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ event: async () => undefined }),
}));

vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({ mutedPubkeys: new Set(), ready: true }),
}));

vi.mock("@/hooks/useReactions", () => ({
  customEmojiReactionTags: () => [],
}));

vi.mock("@/lib/bulkDecryptGate", () => ({
  mayBulkDecrypt: async () => true,
  signerNeedsApproval: () => false,
}));

vi.mock("@/lib/nip17/threadSnapshot", () => ({
  persistDm17ThreadSnapshot: async () => undefined,
  prewarmDm17ThreadSnapshot: async () => undefined,
}));

vi.mock("@/lib/webPushState", () => ({
  markOwnWebPushEvent: async () => undefined,
}));

vi.mock("@/wire/useWireScopes", () => ({
  useWireScopes: () => undefined,
}));

vi.mock("@/wire/notify", () => ({
  dm17NotifyCandidates: () => [],
  feedNotifyCandidates: () => undefined,
}));

vi.mock("@/lib/nip17/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nip17/protocol")>();
  return {
    ...actual,
    openDmWrap: async (wrap: NostrEvent) => h.openedByWrap.get(wrap.id),
  };
});

vi.mock("@/lib/nip17/dm17Store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nip17/dm17Store")>();
  return {
    ...actual,
    queryDm17Thread: async (_self: string, peers: readonly string[], opts: { limit: number }) => {
      h.queryLimits.push(opts.limit);
      const conversation = peers.join(",");
      return h.rows
        .filter((row) => row.peers.join(",") === conversation)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, opts.limit);
    },
    queryDm17Rumor: async (_self: string, peers: readonly string[], rumorId: string) => {
      const conversation = peers.join(",");
      return h.rows.find(
        (row) => row.peers.join(",") === conversation && row.rumorId === rumorId,
      );
    },
    queryDm17Timer: async () => 0,
    readDm17Cursor: async () => undefined,
    readDm17SeenWrapIds: async () => [],
    updateDm17Cursor: async () => undefined,
    writeDm17Rumors: async (_self: string, opened: OpenedDm[]) => {
      const byId = new Map(h.rows.map((row) => [row.rumorId, row]));
      for (const row of opened) byId.set(row.rumorId, row);
      h.rows = [...byId.values()];
    },
    writeDm17SeenWrapIds: async () => undefined,
    sweepExpiredDm17Rumors: async () => 0,
  };
});

import { useDm17Thread } from "@/hooks/useDm17";

function row(index: number, createdAt: number): OpenedDm {
  return {
    rumorId: `rumor-${index}`,
    author: h.peer,
    kind: 14,
    content: `message ${index}`,
    tags: [["p", h.self]],
    createdAt,
    peers: [h.peer],
    wrapId: `wrap-${index}`,
  };
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  h.scope += 1;
  h.self = `self-${h.scope}`;
  h.peer = `peer-${h.scope}`;
  h.rows = [];
  h.relayEvents = [];
  h.openedByWrap.clear();
  h.queryLimits = [];
});

describe("useDm17Thread history window", () => {
  it("keeps a backfilled prior-day page visible across later refetches", async () => {
    const day = 24 * 60 * 60;
    h.rows = Array.from({ length: 300 }, (_, index) => row(index + 100, 1_700_000_000 + day + index));

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const { result } = renderHook(() => useDm17Thread(h.peer), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(300));
    expect(h.queryLimits.at(-1)).toBe(300);

    const older = Array.from({ length: 100 }, (_, index) => row(index, 1_700_000_000 + index));
    h.relayEvents = older.map((opened) => {
      const wrap = {
        id: opened.wrapId,
        kind: 1059,
        pubkey: `ephemeral-${opened.rumorId}`,
        created_at: opened.createdAt,
        content: "wrapped",
        tags: [["p", h.self]],
        sig: "",
      } satisfies NostrEvent;
      h.openedByWrap.set(wrap.id, opened);
      return wrap;
    });

    let added = 0;
    await act(async () => {
      added = await result.current.loadOlder();
    });
    expect(added).toBe(100);
    await waitFor(() => expect(result.current.messages).toHaveLength(400));
    expect(result.current.messages[0]?.rumorId).toBe("rumor-0");
    expect(h.queryLimits.at(-1)).toBe(400);

    // A poll/wire invalidation runs the ordinary queryFn again. Its limit must
    // retain and grow the floor instead of reverting to THREAD_WINDOW (300) or
    // letting a new live row displace the prior-day page scrolling just loaded.
    h.rows.push(row(500, 1_700_000_000 + 2 * day));
    await act(async () => {
      await client.refetchQueries({ queryKey: ["dm17", "thread"] });
    });
    expect(h.queryLimits.slice(-2)).toEqual([400, 401]);
    await waitFor(() => expect(result.current.messages).toHaveLength(401));
    expect(result.current.messages[0]?.rumorId).toBe("rumor-0");
  });

  it("grows the floor by this conversation's rows, not the whole inbox page", async () => {
    // The gift-wrap stream is global (a wrap's author is ephemeral, so there
    // is no per-peer filter): one backfill page pulls older history for EVERY
    // correspondent at once. A busy account therefore scans hundreds of wraps
    // to find a handful for the open thread — and since queryDm17Thread reads
    // CONVERSATION_OVERFETCH times its limit, charging the floor for the whole
    // page makes every later poll re-read other people's archives.
    h.rows = Array.from({ length: 300 }, (_, index) => row(index + 1_000, 1_700_000_000 + index));

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const { result } = renderHook(() => useDm17Thread(h.peer), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(300));

    const other = `stranger-${h.scope}`;
    const page: OpenedDm[] = [
      ...Array.from({ length: 10 }, (_, index) => row(index, 1_699_000_000 + index)),
      ...Array.from({ length: 190 }, (_, index) => ({
        ...row(index, 1_699_000_000 + index),
        rumorId: `other-rumor-${index}`,
        wrapId: `other-wrap-${index}`,
        peers: [other],
      })),
    ];
    h.relayEvents = page.map((opened) => {
      const wrap = {
        id: opened.wrapId,
        kind: 1059,
        pubkey: `ephemeral-${opened.rumorId}`,
        created_at: opened.createdAt,
        content: "wrapped",
        tags: [["p", h.self]],
        sig: "",
      } satisfies NostrEvent;
      h.openedByWrap.set(wrap.id, opened);
      return wrap;
    });

    let added = 0;
    await act(async () => {
      added = await result.current.loadOlder();
    });
    expect(added).toBe(10);
    await waitFor(() => expect(result.current.messages).toHaveLength(310));

    // The next ordinary poll must read the 310 rows this thread has, not the
    // 500 the page happened to scan.
    await act(async () => {
      await client.refetchQueries({ queryKey: ["dm17", "thread"] });
    });
    expect(h.queryLimits.at(-1)).toBe(310);
    expect(result.current.messages).toHaveLength(310);
  });

  it("hydrates one focused rumor outside the bounded window without moving its floor", async () => {
    h.rows = Array.from({ length: 301 }, (_, index) => row(index, 1_700_000_000 + index));
    const focused = h.rows[0];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const { result } = renderHook(() => useDm17Thread(h.peer, focused.rumorId), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.messages.some((message) => message.rumorId === focused.rumorId)).toBe(true));
    expect(result.current.messages).toHaveLength(301);
    expect(h.queryLimits.every((limit) => limit === 300)).toBe(true);

    await act(async () => {
      await client.refetchQueries({ queryKey: ["dm17", "thread"] });
    });
    expect(result.current.messages.some((message) => message.rumorId === focused.rumorId)).toBe(true);
    expect(h.queryLimits.at(-1)).toBe(300);
  });
});

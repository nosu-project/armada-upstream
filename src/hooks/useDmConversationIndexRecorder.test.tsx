import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SELF = "f".repeat(64);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

const h = vi.hoisted(() => ({
  nip04: [] as Array<Record<string, unknown>>,
  nip17: [] as Array<Record<string, unknown>>,
  nip04Loading: false,
  nip17Loading: false,
  trustLoading: false,
  record: vi.fn(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: SELF } }),
}));
vi.mock("@/hooks/useDirectMessages", () => ({
  useDMConversations: () => ({ conversations: h.nip04, isLoading: h.nip04Loading }),
}));
vi.mock("@/hooks/useDm17", () => ({
  useDm17Conversations: () => ({ conversations: h.nip17, isLoading: h.nip17Loading }),
}));
vi.mock("@/hooks/useKnownDmPeers", () => ({
  useKnownDmPeers: () => ({
    isKnown: (peer: string, mine: boolean) => mine || peer === ALICE || peer === BOB,
    isLoading: h.trustLoading,
  }),
}));
vi.mock("@/hooks/useDmConversationIndex", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/useDmConversationIndex")>(),
  recordDmConversationIndex: (...args: unknown[]) => h.record(...args),
}));

import { useRecordDmConversationIndex } from "@/hooks/useDmConversationIndexSync";

function rumor(id: string, pubkey: string, createdAt: number) {
  return { id, pubkey, created_at: createdAt, kind: 4, content: "cipher", tags: [] };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.record.mockReset().mockResolvedValue(true);
  h.nip04Loading = false;
  h.nip17Loading = false;
  h.trustLoading = false;
  h.nip04 = [
    { peer: ALICE, latest: rumor("1".repeat(64), ALICE, 10), mine: false },
    { peer: CAROL, latest: rumor("2".repeat(64), CAROL, 20), mine: false },
    { peer: CAROL, latest: rumor("3".repeat(64), SELF, 30), mine: true },
  ];
  h.nip17 = [
    {
      key: `${ALICE},${BOB}`,
      peers: [ALICE, BOB],
      latest: { createdAt: 40, rumorId: "4".repeat(64) },
      mine: false,
    },
    {
      key: `${ALICE},${CAROL}`,
      peers: [ALICE, CAROL],
      latest: { createdAt: 50, rumorId: "5".repeat(64) },
      mine: false,
    },
  ];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("always-mounted DM index recorder", () => {
  it("records only real rows that pass the main-inbox trust predicate", async () => {
    renderHook(() => useRecordDmConversationIndex());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(h.record).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledWith(SELF, [
      { key: ALICE, latest: { createdAt: 10, id: "1".repeat(64) }, mine: false },
      { key: CAROL, latest: { createdAt: 30, id: "3".repeat(64) }, mine: true },
      {
        key: `${ALICE},${BOB}`,
        latest: { createdAt: 40, id: "4".repeat(64) },
        mine: false,
      },
    ]);
  });

  it("waits until message and trust sources have all settled", async () => {
    h.trustLoading = true;
    const view = renderHook(() => useRecordDmConversationIndex());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(h.record).not.toHaveBeenCalled();

    h.trustLoading = false;
    view.rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(h.record).toHaveBeenCalledOnce();
  });
});

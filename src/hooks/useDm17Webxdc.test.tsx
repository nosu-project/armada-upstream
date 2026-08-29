/**
 * What `useDm17Thread.sendWebxdc` actually puts on the wire.
 *
 * The three metadata fields are webxdc's own `sendUpdate` payload, not
 * decoration: an app that names the document it is editing, or summarises its
 * state for the chat row, gets that from `info`/`document`/`summary`. They
 * were silently dropped by a version that took pre-built tags and rebuilt them
 * from the session id alone, so the same Mini App behaved differently in a DM
 * than it does in a Concord channel.
 */

import { NSecSigner } from "@nostrify/nostrify";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenedDm } from "@/lib/nip17/protocol";
import type { ReactNode } from "react";

const RELAY = "wss://dm.test";

const h = vi.hoisted(() => {
  return {
    self: "",
    peer: "",
    signer: undefined as unknown,
    written: [] as OpenedDm[],
  };
});

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({ query: async () => [] }),
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
    user: { pubkey: h.self, method: "nsec", signer: h.signer },
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

vi.mock("@/lib/nip17/dm17Store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nip17/dm17Store")>();
  return {
    ...actual,
    queryDm17Thread: async () => [],
    queryDm17Rumor: async () => undefined,
    queryDm17Timer: async () => 0,
    readDm17Cursor: async () => undefined,
    readDm17SeenWrapIds: async () => [],
    updateDm17Cursor: async () => undefined,
    writeDm17Rumors: async (_self: string, opened: OpenedDm[]) => {
      h.written.push(...opened);
    },
    writeDm17SeenWrapIds: async () => undefined,
    sweepExpiredDm17Rumors: async () => 0,
  };
});

import { useDm17Thread } from "@/hooks/useDm17";
import { KIND_DM_WEBXDC } from "@/lib/nip17/protocol";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  const sk = generateSecretKey();
  h.self = getPublicKey(sk);
  h.peer = getPublicKey(generateSecretKey());
  h.signer = new NSecSigner(sk);
  h.written = [];
});

describe("sendWebxdc", () => {
  it("carries the session id and the update metadata onto the rumor", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const { result } = renderHook(() => useDm17Thread(h.peer), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.canSend).toBe(true));

    const uuid = "A".repeat(52);
    // Exactly what `useDmAppSync.sendState` passes through from the Mini App's
    // `sendUpdate`: the session, the payload, and the three optional fields.
    await act(async () => {
      await result.current.sendWebxdc(uuid, JSON.stringify({ score: 3 }), {
        info: "Alice scored",
        document: "board",
        summary: "3-1",
      });
    });

    await waitFor(() => expect(h.written.length).toBeGreaterThan(0));
    const sent = h.written.find((row) => row.kind === KIND_DM_WEBXDC);
    expect(sent).toBeDefined();

    // The session the attachment named, which is what scopes the read back.
    expect(sent!.tags).toContainEqual(["i", uuid]);
    // The three metadata fields are webxdc's own `sendUpdate` payload, not
    // decoration: Concord's plane delivers all of them, so the DM plane must
    // too or the same app behaves differently in a DM.
    expect(sent!.tags).toContainEqual(["info", "Alice scored"]);
    expect(sent!.tags).toContainEqual(["document", "board"]);
    expect(sent!.tags).toContainEqual(["summary", "3-1"]);
    // And the conversation is still named the way every other rumor names it.
    expect(sent!.tags).toContainEqual(["p", h.peer]);
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBlossomServerList } from "@/hooks/useBlossomServerList";
import { useDmRelayList } from "@/hooks/useDmRelayList";
import { useSearchRelayList } from "@/hooks/useSearchRelayList";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ReactNode } from "react";

const SECRET = generateSecretKey();
const PUBKEY = getPublicKey(SECRET);
const RELAY = "wss://state.example";

const h = vi.hoisted(() => ({
  local: [] as NostrRumor[],
  wire: [] as NostrEvent[],
  publish: vi.fn(),
  queryError: false,
  user: undefined as unknown,
  config: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: () => ({
        query: async (filters: Array<{ kinds?: number[] }>) => {
          if (h.queryError) throw new Error("relay unavailable");
          return h.wire.filter(
            (event) => filters.some((filter) => filter.kinds?.includes(event.kind)),
          );
        },
      }),
    },
  }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({
    query: async (filters: Array<{ kinds?: number[] }>) => h.local.filter(
      (event) => filters.some((filter) => filter.kinds?.includes(event.kind)),
    ),
  }),
}));

vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function wireEvent(kind: number, tags: string[][], createdAt = 100): NostrEvent {
  return finalizeEvent({ kind, tags, content: "", created_at: createdAt }, SECRET);
}

function localRumor(
  event: NostrEvent,
  id: string,
  createdAt: number,
  tags: string[][],
): NostrRumor {
  return {
    id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: createdAt,
    tags,
    content: event.content,
  };
}

describe("canonical service-list hooks", () => {
  beforeEach(() => {
    h.user = {
      pubkey: PUBKEY,
      signer: {
        nip44: {
          encrypt: async (_pubkey: string, plaintext: string) => plaintext,
          decrypt: async (_pubkey: string, ciphertext: string) => ciphertext,
        },
      },
    };
    h.config = {
      useAppRelays: true,
      appRelays: [RELAY],
      useUserRelays: false,
      relayMetadata: { relays: [], updatedAt: 0 },
    };
    h.queryError = false;
    const staleSearch = wireEvent(10007, [["relay", "wss://stale-search.example"]]);
    const staleDm = wireEvent(10050, [["relay", "wss://stale-dm.example"]]);
    const staleBlossom = wireEvent(10063, [["server", "https://stale-media.example/"]]);
    h.wire = [staleSearch, staleDm, staleBlossom];
    h.local = [
      localRumor(
        staleSearch,
        "a".repeat(64),
        200,
        [["relay", "wss://local-search.example"], ["search-extra", "kept"]],
      ),
      // Same second as the wire copy: the lower id is the NIP-01 winner.
      localRumor(
        staleDm,
        "0".repeat(64),
        100,
        [["relay", "wss://local-dm.example"], ["dm-extra", "kept"]],
      ),
      localRumor(
        staleBlossom,
        "b".repeat(64),
        200,
        [["server", "https://local-media.example/"], ["media-extra", "kept"]],
      ),
    ];
    h.publish.mockReset().mockImplementation(async (template: {
      kind: number;
      tags: string[][];
      content: string;
      created_at: number;
      onSigned?: (event: NostrEvent) => void;
    }) => {
      const event = finalizeEvent({
        kind: template.kind,
        tags: template.tags,
        content: template.content,
        created_at: template.created_at,
      }, SECRET);
      template.onSigned?.(event);
      return event;
    });
  });

  it("reads and mutates from the local+wire winner for all three lists", async () => {
    const view = renderHook(() => ({
      search: useSearchRelayList(),
      dm: useDmRelayList(),
      blossom: useBlossomServerList(),
    }), { wrapper });

    await waitFor(() => {
      expect(view.result.current.search.relays).toEqual(["wss://local-search.example"]);
      expect(view.result.current.dm.relays).toEqual(["wss://local-dm.example"]);
      expect(view.result.current.blossom.servers).toEqual(["https://local-media.example/"]);
    });
    expect(view.result.current.dm.isReady).toBe(true);

    await act(async () => {
      await Promise.all([
        view.result.current.search.publish(["wss://next-search.example"]),
        view.result.current.dm.publish(["wss://next-dm.example"]),
        view.result.current.blossom.publish(["https://next-media.example/"]),
      ]);
    });

    const byKind = new Map(
      h.publish.mock.calls.map(([template]) => [template.kind, template] as const),
    );
    expect(byKind.get(10007)).toMatchObject({
      prev: { id: "a".repeat(64) },
      relays: [RELAY],
      inheritPendingTargets: false,
    });
    expect(byKind.get(10007)?.tags).toContainEqual(["search-extra", "kept"]);
    expect(byKind.get(10050)).toMatchObject({
      prev: { id: "0".repeat(64) },
      relays: [RELAY],
      inheritPendingTargets: false,
    });
    expect(byKind.get(10050)?.tags).toContainEqual(["dm-extra", "kept"]);
    expect(view.result.current.dm.isReady).toBe(true);
    expect(byKind.get(10063)).toMatchObject({
      prev: { id: "b".repeat(64) },
      relays: [RELAY],
      inheritPendingTargets: false,
    });
    expect(byKind.get(10063)?.tags).toContainEqual(["media-extra", "kept"]);
  });

  it("refuses an edit when no account-state relay confirms the read", async () => {
    const view = renderHook(() => useDmRelayList(), { wrapper });
    await waitFor(() => expect(view.result.current.relays).toEqual([
      "wss://local-dm.example",
    ]));
    h.publish.mockClear();
    h.queryError = true;

    await act(async () => {
      await expect(view.result.current.publish(["wss://next-dm.example"]))
        .rejects.toThrow(/confirm your current DM relay list/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("keeps stored DM relays additive-only when the wire read fails", async () => {
    h.queryError = true;
    const view = renderHook(() => useDmRelayList(), { wrapper });

    await waitFor(() => expect(view.result.current.relays).toEqual([
      "wss://local-dm.example",
    ]));
    expect(view.result.current.isReady).toBe(false);
  });
});

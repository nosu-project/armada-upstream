import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExistingRelayListError,
  RelayListAbsenceUnconfirmedError,
  relayListAbsenceConfirmed,
  relayPointerChangedDuringPreseed,
  useNip65RelaySetup,
} from "@/hooks/useNip65RelaySetup";
import {
  fetchPortableWireState,
  mirrorPortableStateBeforeRelayChange,
} from "@/hooks/usePublishPortableSetup";
import { installAbortSignalPolyfills } from "@/lib/abortSignalPolyfill";
import { RELAY_LIST_DISCOVERY_RELAYS } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SECRET = new Uint8Array(32).fill(7);
const SELF = getPublicKey(SECRET);
const h = vi.hoisted(() => ({
  relayEvent: vi.fn<(url: string, ...args: unknown[]) => Promise<void>>(async () => undefined),
  relayQuery: vi.fn<(url: string, ...args: unknown[]) => Promise<unknown[]>>(async () => {
    throw new Error("offline");
  }),
  discoverRead: vi.fn(),
  lastPublished: undefined as undefined | Record<string, unknown>,
  updateConfig: vi.fn(),
  ownsPointer: true,
  signedKinds: [] as number[],
  persistedInvites: undefined as undefined | { list: unknown; newestCreatedAt: number },
}));

vi.mock("@/concord/hooks/useInvites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/hooks/useInvites")>()),
  readPersistedInviteList: async () => h.persistedInvites,
}));

vi.mock("@/lib/nip65", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nip65")>()),
  discoverRelayListWithStatus: (...args: unknown[]) => h.discoverRead(...args),
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      query: vi.fn(async () => []),
      relay: (url: string) => ({
        query: (...args: unknown[]) => h.relayQuery(url, ...args),
        event: (event: Record<string, unknown>, ...args: unknown[]) => {
          if (event.kind === 10002) h.lastPublished = event;
          return h.relayEvent(url, event, ...args);
        },
      }),
    },
  }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: {
      pubkey: SELF,
      method: "nsec",
      signer: {
        signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => {
          h.signedKinds.push(template.kind);
          return finalizeEvent(template, SECRET);
        },
      },
    },
  }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: vi.fn(async () => []) }),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      useAppRelays: true,
      useUserRelays: true,
      appRelays: ["wss://app.example"],
      relayMetadata: h.ownsPointer
        ? {
          pubkey: SELF,
          updatedAt: 1,
          relays: [
            { url: "wss://old.example", read: true, write: true },
            { url: "wss://old-two.example", read: true, write: true },
          ],
        }
        : { pubkey: undefined, updatedAt: 0, relays: [] },
    },
    updateConfig: h.updateConfig,
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  h.ownsPointer = true;
  h.lastPublished = undefined;
  h.signedKinds = [];
  h.persistedInvites = undefined;
  h.relayEvent.mockReset().mockResolvedValue(undefined);
  h.relayQuery.mockReset().mockRejectedValue(new Error("offline"));
  h.discoverRead.mockReset().mockImplementation(async () => {
    const event = h.lastPublished ?? {
      kind: 10002,
      id: "d".repeat(64),
      pubkey: SELF,
      sig: "e".repeat(128),
      content: "",
      tags: [["r", "wss://old.example"], ["r", "wss://old-two.example"]],
      created_at: 1,
    };
    return {
      events: [event],
      answered: [
        "wss://old.example",
        "wss://old-two.example",
        "wss://new.example",
        "wss://app.example",
      ],
      failed: [],
      discovery: {
        event,
        relays: [
          { url: "wss://old.example", read: true, write: true },
          { url: "wss://old-two.example", read: true, write: true },
        ],
      },
    };
  });
  h.updateConfig.mockReset();
});

describe("useNip65RelaySetup two-phase publish", () => {
  it("detects a sibling pointer that became newer during phase one", () => {
    expect(relayPointerChangedDuringPreseed(
      {
        pubkey: SELF,
        updatedAt: 10,
        eventId: "f".repeat(64),
        relays: [],
      },
      SELF,
      { created_at: 11, id: "e".repeat(64) },
    )).toBe(true);
    expect(relayPointerChangedDuringPreseed(
      {
        pubkey: SELF,
        updatedAt: 10,
        eventId: "f".repeat(64),
        relays: [],
      },
      SELF,
      { created_at: 10, id: "0".repeat(64) },
    )).toBe(true);
  });

  it("does not publish kind 10002 when every old/source relay fails", async () => {
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/current account-state relays completed/i);
    });

    expect(h.relayEvent).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("does not let one answering stale source mask another old state relay's failure", async () => {
    h.relayQuery.mockImplementation(async (url: unknown) => {
      if (url === "wss://old.example") throw new Error("old relay offline");
      return [];
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/current account-state relays completed/i);
    });

    expect(h.relayEvent).not.toHaveBeenCalled();
  });

  it("does not adopt when the old relay misses the new 10002 pointer", async () => {
    h.relayQuery.mockResolvedValue([]);
    h.relayEvent.mockImplementation(async (url: unknown) => {
      if (url === "wss://old.example") throw new Error("old relay rejected pointer");
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/existing account-state relay missed/i);
    });

    expect(h.relayEvent).toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("queues but does not block adoption when only an app fallback misses the pointer", async () => {
    h.relayQuery.mockImplementation(async () => h.lastPublished ? [h.lastPublished] : []);
    h.relayEvent.mockImplementation(async (url: unknown) => {
      if (url === "wss://app.example") throw new Error("public fallback offline");
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).resolves.toMatchObject({ rejected: ["wss://app.example"] });
    });

    expect(h.relayEvent).toHaveBeenCalled();
    expect(h.updateConfig).toHaveBeenCalled();
  });

  it("does not sign when the known pointer cannot be refreshed after preseed", async () => {
    h.relayQuery.mockResolvedValue([]);
    h.discoverRead.mockResolvedValueOnce({
      events: [],
      answered: [],
      failed: ["wss://old.example", "wss://old-two.example"],
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/refresh the current NIP-65/i);
    });

    expect(h.relayEvent).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("does not sign when a proposed relay already holds a newer NIP-65 pointer", async () => {
    h.relayQuery.mockResolvedValue([]);
    const newer = finalizeEvent({
      kind: 10002,
      content: "",
      tags: [["r", "wss://new.example"]],
      created_at: 2,
    }, SECRET);
    h.discoverRead.mockResolvedValueOnce({
      events: [newer],
      answered: ["wss://old.example", "wss://old-two.example", "wss://new.example"],
      failed: [],
      discovery: {
        event: newer,
        relays: [{ url: "wss://new.example", read: true, write: true }],
      },
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/changed on another device/i);
    });

    expect(h.relayEvent).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("does not sign when a proposed relay misses the final pointer refresh", async () => {
    h.relayQuery.mockResolvedValue([]);
    const baseline = finalizeEvent({
      kind: 10002,
      content: "",
      tags: [["r", "wss://old.example"], ["r", "wss://old-two.example"]],
      created_at: 1,
    }, SECRET);
    h.discoverRead.mockResolvedValueOnce({
      events: [baseline],
      answered: ["wss://old.example", "wss://old-two.example"],
      failed: ["wss://new.example"],
      discovery: {
        event: baseline,
        relays: [
          { url: "wss://old.example", read: true, write: true },
          { url: "wss://old-two.example", read: true, write: true },
        ],
      },
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/refresh the current NIP-65/i);
    });

    expect(h.relayEvent).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("re-mirrors a portable coordinate changed during phase one before publishing the pointer", async () => {
    const baseline = finalizeEvent({
      kind: 10002,
      content: "",
      tags: [["r", "wss://old.example"], ["r", "wss://old-two.example"]],
      created_at: 1,
    }, SECRET);
    const stateA = finalizeEvent({
      kind: 10007,
      content: "",
      tags: [["relay", "wss://search-a.example"]],
      created_at: 10,
    }, SECRET);
    const stateB = finalizeEvent({
      kind: 10007,
      content: "",
      tags: [["relay", "wss://search-b.example"]],
      created_at: 11,
    }, SECRET);
    let pointerRefreshes = 0;
    h.relayQuery.mockImplementation(async (
      _url: string,
      filtersValue: unknown,
    ) => {
      const filters = filtersValue as Array<{ kinds?: number[] }>;
      const kinds = new Set(filters.flatMap((filter) => filter.kinds ?? []));
      if (kinds.has(10007)) {
        return [pointerRefreshes === 0 ? stateA : stateB, baseline];
      }
      if (kinds.has(10002)) return h.lastPublished ? [h.lastPublished] : [baseline];
      return [];
    });
    h.discoverRead.mockImplementation(async () => {
      const event = h.lastPublished ?? baseline;
      if (!h.lastPublished) pointerRefreshes += 1;
      return {
        events: [event],
        answered: [
          "wss://old.example",
          "wss://old-two.example",
          "wss://new.example",
          "wss://app.example",
        ],
        failed: [],
        discovery: {
          event,
          relays: [{ url: "wss://old.example", read: true, write: true }],
        },
      };
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).resolves.toMatchObject({ rejected: [] });
    });

    const published = h.relayEvent.mock.calls.map((call) => call[1] as NostrEvent);
    expect(published.some(({ id }) => id === stateB.id)).toBe(true);
    expect(published.some(({ kind }) => kind === 10002)).toBe(true);
    expect(h.updateConfig).toHaveBeenCalled();
  });

  it("does not adopt when a sibling pointer wins after this event was acknowledged", async () => {
    h.relayQuery.mockImplementation(async () => h.lastPublished ? [h.lastPublished] : []);
    const baselineEvent = {
      kind: 10002,
      id: "d".repeat(64),
      pubkey: SELF,
      sig: "e".repeat(128),
      content: "",
      tags: [["r", "wss://old.example"]],
      created_at: 1,
    };
    const baselineRead = {
      events: [baselineEvent],
      answered: ["wss://old.example", "wss://old-two.example", "wss://new.example"],
      failed: [],
      discovery: {
        event: baselineEvent,
        relays: [{ url: "wss://old.example", read: true, write: true }],
      },
    };
    h.discoverRead
      .mockResolvedValueOnce(baselineRead)
      .mockResolvedValueOnce(baselineRead)
      .mockImplementationOnce(async () => {
        const event = {
          kind: 10002,
          id: "0".repeat(64),
          pubkey: SELF,
          sig: "f".repeat(128),
          content: "",
          tags: [["r", "wss://sibling.example"]],
          created_at: Number((h.lastPublished?.created_at as number | undefined) ?? 1) + 1,
        };
        return {
          events: [event],
          answered: ["wss://old.example", "wss://old-two.example", "wss://new.example"],
          failed: [],
          discovery: { event, relays: [{ url: "wss://sibling.example", read: true, write: true }] },
        };
      });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/won while this change was publishing/i);
    });

    expect(h.relayEvent).toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("does not adopt when one authoritative relay answers with only the stale pointer", async () => {
    h.relayQuery.mockImplementation(async (url: unknown) => {
      if (!h.lastPublished) return [];
      if (url === "wss://old-two.example") {
        return [finalizeEvent({
          kind: 10002,
          content: "",
          tags: [["r", "wss://old-two.example"]],
          created_at: 1,
        }, SECRET)];
      }
      return [h.lastPublished];
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).rejects.toThrow(/did not retain the new NIP-65 winner/i);
    });

    expect(h.relayEvent).toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("publishes on a WebView that predates AbortSignal.any", async () => {
    // Android System WebView before Chromium 116 (a stock Android 13 Samsung
    // was reported) has AbortSignal.timeout but not AbortSignal.any. "Use this
    // relay" then failed with "AbortSignal.any is not a function" from the
    // portable-state mirror. The polyfill main.tsx installs first is what
    // keeps the flow working there, so run it after removing the static.
    const statics = AbortSignal as unknown as Record<string, unknown>;
    const originalAny = statics.any;
    delete statics.any;
    try {
      installAbortSignalPolyfills();
      h.relayQuery.mockImplementation(async () => h.lastPublished ? [h.lastPublished] : []);
      const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

      await act(async () => {
        await expect(result.current.publish([
          { url: "wss://new.example", read: true, write: true },
        ])).resolves.toMatchObject({ rejected: [] });
      });

      expect(h.relayEvent).toHaveBeenCalled();
      expect(h.updateConfig).toHaveBeenCalled();
    } finally {
      statics.any = originalAny;
    }
  });

  it("requests enough dynamic topic coordinates for the bounded DM shard set", async () => {
    const query = vi.fn(async () => []);
    const nostr = {
      query,
      relay: () => ({ query, event: vi.fn() }),
    };
    await fetchPortableWireState(
      nostr as never,
      {
        pubkey: SELF,
        signer: { nip44: { decrypt: vi.fn(), encrypt: vi.fn() } },
      } as never,
      ["wss://old.example"],
      AbortSignal.timeout(1_000),
    );

    const calls = query.mock.calls as unknown as Array<[
      Array<{ "#t"?: string[]; limit?: number }>,
    ]>;
    const filters = calls[0]?.[0] ?? [];
    const topic = filters.find((filter) => filter["#t"]?.includes("armada-dm-conversations"));
    expect(topic?.limit).toBeGreaterThanOrEqual(128);
  });

  it("allows first setup when one bootstrap source answers and other public indexes are down", async () => {
    const good = "wss://bootstrap-good.example";
    const bad = "wss://bootstrap-bad.example";
    const nostr = {
      query: vi.fn(async () => []),
      relay: (url: string) => ({
        query: async () => {
          if (url === bad) throw new Error("offline");
          return [];
        },
        event: vi.fn(),
      }),
    };

    await expect(fetchPortableWireState(
      nostr as never,
      {
        pubkey: SELF,
        signer: { nip44: { decrypt: vi.fn(), encrypt: vi.fn() } },
      } as never,
      [good, bad],
      AbortSignal.timeout(1_000),
      [good, bad],
      false,
    )).resolves.toMatchObject({ events: [], communityEvents: [] });
  });

  it("hands back an existing list, not a 'changed on another device' error, when none was known locally", async () => {
    h.ownsPointer = false;
    h.relayQuery.mockResolvedValue([]);
    const existing = finalizeEvent({
      kind: 10002,
      content: "",
      tags: [["r", "wss://elsewhere.example"]],
      created_at: 3,
    }, SECRET);
    const discovery = {
      event: existing,
      relays: [{ url: "wss://elsewhere.example", read: true, write: true }],
    };
    h.discoverRead.mockResolvedValueOnce({
      events: [existing],
      answered: ["wss://app.example", "wss://new.example"],
      failed: [],
      discovery,
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ]).catch((err: unknown) => err);
    });

    expect(thrown).toBeInstanceOf(ExistingRelayListError);
    expect((thrown as ExistingRelayListError).discovery).toBe(discovery);
    expect(h.relayEvent).not.toHaveBeenCalled();
      expect(h.signedKinds).toEqual([]);
    // Found before phase one: the portable-state mirror never even read.
    expect(h.relayQuery).not.toHaveBeenCalled();
  });

  it("signs and publishes nothing when a first list's absence can't be confirmed", async () => {
    h.ownsPointer = false;
    h.relayQuery.mockResolvedValue([]);
    h.discoverRead.mockResolvedValue({
      events: [],
      // The proposed relay answered, but the app relay and the indexes did not.
      answered: ["wss://new.example"],
      failed: ["wss://app.example", ...RELAY_LIST_DISCOVERY_RELAYS],
    });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ]).catch((err: unknown) => err);
    });

    expect(thrown).toBeInstanceOf(RelayListAbsenceUnconfirmedError);
    expect(h.signedKinds).toEqual([]);
    expect(h.relayEvent).not.toHaveBeenCalled();
    expect(h.relayQuery).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("creates a first list once every destination and most indexes confirm there is none", async () => {
    h.ownsPointer = false;
    const answered = ["wss://new.example", "wss://app.example", ...RELAY_LIST_DISCOVERY_RELAYS];
    h.relayQuery.mockImplementation(async () => h.lastPublished ? [h.lastPublished] : []);
    h.discoverRead.mockImplementation(async () => h.lastPublished
      ? {
        events: [h.lastPublished],
        answered,
        failed: [],
        discovery: {
          event: h.lastPublished,
          relays: [{ url: "wss://new.example", read: true, write: true }],
        },
      }
      : { events: [], answered, failed: [] });
    const result = renderHook(() => useNip65RelaySetup(), { wrapper }).result;

    await act(async () => {
      await expect(result.current.publish([
        { url: "wss://new.example", read: true, write: true },
      ])).resolves.toMatchObject({ rejected: [] });
    });

    expect(h.signedKinds).toEqual([10002]);
    expect(h.updateConfig).toHaveBeenCalled();
  });

  it("refuses to re-sign a known creator invite list the portable read did not return", async () => {
    h.persistedInvites = {
      list: { entries: [{ token: "t" }], tombstones: [] },
      newestCreatedAt: 50,
    };
    const nostr = {
      query: vi.fn(async () => []),
      relay: () => ({ query: vi.fn(async () => []), event: h.relayEvent }),
    };

    await expect(mirrorPortableStateBeforeRelayChange(
      nostr as never,
      {
        pubkey: SELF,
        signer: {
          signEvent: async (template: Parameters<typeof finalizeEvent>[0]) => {
            h.signedKinds.push(template.kind);
            return finalizeEvent(template, SECRET);
          },
          nip44: { decrypt: vi.fn(), encrypt: vi.fn(async () => "ciphertext") },
        },
      } as never,
      ["wss://old.example"],
      ["wss://new.example"],
    )).rejects.toThrow(/creator invite list was absent/i);

    expect(h.signedKinds).toEqual([]);
    expect(h.relayEvent).not.toHaveBeenCalled();
  });
});

describe("relayListAbsenceConfirmed", () => {
  const app = ["wss://app-one.example", "wss://app-two.example"];
  const indexes = ["wss://i1.example", "wss://i2.example", "wss://i3.example"];

  it("needs every app relay and a majority of the discovery indexes", () => {
    expect(relayListAbsenceConfirmed([...app, ...indexes], app, indexes)).toBe(true);
    expect(relayListAbsenceConfirmed([...app, "wss://i1.example", "wss://i3.example"], app, indexes)).toBe(true);
    expect(relayListAbsenceConfirmed([...app, "wss://i1.example"], app, indexes)).toBe(false);
    expect(relayListAbsenceConfirmed(["wss://app-one.example", ...indexes], app, indexes)).toBe(false);
  });

  it("counts an index that is also an app relay only once, as an app relay", () => {
    expect(relayListAbsenceConfirmed(["wss://i1.example"], ["wss://i1.example"], ["wss://i1.example"])).toBe(true);
    expect(relayListAbsenceConfirmed([], [], [])).toBe(false);
  });
});

/**
 * Regression tests for the kind-10009 list-wipe bug class.
 *
 * The user's NIP-51 "Simple groups" list (servers + joined channels) is a
 * replaceable event mutated by read-modify-write. Two relay failure modes are
 * indistinguishable from "the user has no list yet" in a bare network read —
 * an empty result (cold pool / AUTH / wrong relay set) and a stale echo — and
 * building the write on either destroys the real list everywhere. A third bug
 * silently re-encrypted lists that other clients (Flotilla/Coracle) had
 * published as public tags, blanking the list for every client that reads the
 * public tags. See AGENTS.md "Never publish a user's Nostr lists without an
 * explicit user action."
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveGroupListRead,
  useUserGroupList,
  useUpdateUserGroupList,
  type UserGroupListQuery,
} from "@/hooks/useUserGroupList";
import { buildGroupListTags, type GroupRef } from "@/lib/nip29";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const S1 = normalizeRelayUrl("wss://one.example")!;
const S2 = normalizeRelayUrl("wss://two.example")!;
const S3 = normalizeRelayUrl("wss://three.example")!;
const S4 = normalizeRelayUrl("wss://four.example")!;
const S5 = normalizeRelayUrl("wss://five.example")!;

const h = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readFolded: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  writeFolded: vi.fn<(...args: unknown[]) => Promise<void>>(),
  storeQuery: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  removeRailKey: vi.fn<(key: string) => void>(),
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      query: h.query,
      relay: () => ({ query: h.query }),
    },
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      useAppRelays: true,
      appRelays: [S1],
      useUserRelays: false,
      relayMetadata: { relays: [], updatedAt: 0 },
    },
  }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));
vi.mock("@/lib/nip65", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nip65")>();
  return {
    ...actual,
    queryExplicitRelaysWithStatus: async (
      _nostr: unknown,
      relays: Iterable<string>,
      ...args: unknown[]
    ) => {
      const urls = [...relays];
      try {
        return { events: await h.query(...args), answered: urls, failed: [] };
      } catch {
        return { events: [], answered: [], failed: urls };
      }
    },
  };
});
vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
}));
vi.mock("@/hooks/useRemoveRailKey", () => ({
  useRemoveRailKey: () => h.removeRailKey,
}));
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve({ query: h.storeQuery }),
}));

/** Reversible fake NIP-44: ciphertext is `enc:` + plaintext. */
const nip44 = {
  encrypt: async (_pk: string, plaintext: string) => `enc:${plaintext}`,
  decrypt: async (_pk: string, ciphertext: string) => {
    if (!ciphertext.startsWith("enc:")) throw new Error("bad ciphertext");
    return ciphertext.slice(4);
  },
};

let evCounter = 0;
function listEvent(opts: { createdAt: number; tags?: string[][]; content?: string }): NostrEvent {
  return {
    id: `ev${++evCounter}`.padEnd(64, "0").slice(0, 64),
    pubkey: SELF,
    created_at: opts.createdAt,
    kind: 10009,
    tags: opts.tags ?? [],
    content: opts.content ?? "",
    sig: "f".repeat(128),
  };
}

/** Encrypted `.content` for a list, matching the fake NIP-44 above. */
function encContent(list: { groups: GroupRef[]; servers: string[] }): string {
  return `enc:${JSON.stringify(buildGroupListTags(list))}`;
}

/** The item tags decoded back out of a published encrypted `.content`. */
function decodePublished(): string[][] {
  const arg = h.publish.mock.calls[0][0] as { content: string };
  expect(arg.content.startsWith("enc:")).toBe(true);
  return JSON.parse(arg.content.slice(4)) as string[][];
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderUpdate() {
  return renderHook(() => useUpdateUserGroupList(), { wrapper }).result;
}

beforeEach(() => {
  h.query.mockReset();
  h.publish.mockReset();
  h.readFolded.mockReset().mockResolvedValue(undefined);
  h.writeFolded.mockReset().mockResolvedValue(undefined);
  h.storeQuery.mockReset().mockResolvedValue([]);
  h.removeRailKey.mockReset();
  h.user = { pubkey: SELF, signer: { nip44 } };
  h.publish.mockImplementation(async (t) => ({
    ...(t as object),
    id: "b".repeat(64),
    pubkey: SELF,
    created_at: 9999,
    sig: "s".repeat(128),
  }));
});

describe("kind 10009 refresh last-good guards", () => {
  function good(event: NostrEvent, servers = [S1]): UserGroupListQuery {
    return { event, groups: [], servers, decryptFailed: false };
  }

  it("keeps the last decrypted list across an empty or stale relay read", async () => {
    const heldEvent = listEvent({ createdAt: 200, content: encContent({ groups: [], servers: [S1, S2] }) });
    const held = good(heldEvent, [S1, S2]);
    const stale = listEvent({ createdAt: 100, content: encContent({ groups: [], servers: [S3] }) });

    expect(await resolveGroupListRead([], { nip44 } as never, held)).toBe(held);
    expect(await resolveGroupListRead([stale], { nip44 } as never, held)).toBe(held);
  });

  it("uses the NIP-01 lowest-id tiebreak and accepts an intentional newer clear", async () => {
    const heldEvent = { ...listEvent({ createdAt: 200 }), id: "f".repeat(64) };
    const held = good(heldEvent, [S1]);
    const tiedWinner = {
      ...listEvent({ createdAt: 200, content: encContent({ groups: [], servers: [S2] }) }),
      id: "0".repeat(64),
    };
    expect((await resolveGroupListRead([tiedWinner], { nip44 } as never, held)).servers).toEqual([S2]);

    const clear = listEvent({
      createdAt: 201,
      content: encContent({ groups: [], servers: [] }),
    });
    expect((await resolveGroupListRead([clear], { nip44 } as never, held)).servers).toEqual([]);
  });

  it("does not let a newer undecryptable event blank the last-good list", async () => {
    const heldEvent = listEvent({ createdAt: 200 });
    const held = good(heldEvent, [S1, S2]);
    const unreadable = listEvent({ createdAt: 201, content: "not-our-ciphertext" });

    expect(await resolveGroupListRead([unreadable], { nip44 } as never, held)).toBe(held);
  });

  it("does not treat a boot-fold seed as wire-authoritative", async () => {
    let finishWire!: (events: NostrEvent[]) => void;
    h.query.mockImplementation(() => new Promise<NostrEvent[]>((resolve) => {
      finishWire = resolve;
    }));
    h.readFolded.mockResolvedValue({
      event: listEvent({ createdAt: 100 }),
      groups: [],
      servers: [S1],
    });

    const view = renderHook(() => useUserGroupList(), { wrapper });
    await waitFor(() => expect(view.result.current.data?.servers).toEqual([S1]));
    expect(view.result.current.data?.wireReady).not.toBe(true);

    await act(async () => { finishWire([]); });
    await waitFor(() => expect(view.result.current.data?.wireReady).toBe(true));
  });
});

describe("useUpdateUserGroupList (kind 10009 read-modify-write)", () => {
  it("does not sign a fresh empty-base list when the account relay read fails", async () => {
    h.query.mockRejectedValue(new Error("offline"));
    h.readFolded.mockResolvedValue(undefined);

    const result = renderUpdate();
    await act(async () => {
      await expect(
        result.current.mutateAsync({ type: "add-server", url: S2 }),
      ).rejects.toThrow(/an account-state relay/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("REFUSES to build on an empty network read when a persisted list exists (the wipe)", async () => {
    h.query.mockResolvedValue([]);
    h.readFolded.mockResolvedValue({
      event: listEvent({ createdAt: 100, content: encContent({ groups: [], servers: [S1, S2] }) }),
      groups: [],
      servers: [S1, S2],
    });

    const result = renderUpdate();
    await act(async () => {
      await expect(
        result.current.mutateAsync({ type: "add-server", url: S3 }),
      ).rejects.toThrow(/not saving/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("publishes a fresh encrypted list only when neither the network nor local state has one", async () => {
    h.query.mockResolvedValue([]);
    h.readFolded.mockResolvedValue(undefined);

    const result = renderUpdate();
    await act(async () => {
      await result.current.mutateAsync({ type: "add-server", url: S1 });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(decodePublished()).toContainEqual(["r", S1]);
    // Items live in encrypted content for a new list; no public item tags.
    const arg = h.publish.mock.calls[0][0] as { tags: string[][] };
    expect(arg.tags.filter(([n]) => n === "r" || n === "group")).toEqual([]);
  });

  it("bases the edit on the newer persisted copy when the relay echoes a stale event", async () => {
    // Relay hands back the pre-previous-write version (only S1)…
    h.query.mockResolvedValue([
      listEvent({ createdAt: 100, content: encContent({ groups: [], servers: [S1] }) }),
    ]);
    // …but this device already holds the newer list with S1 + S2.
    h.readFolded.mockResolvedValue({
      event: listEvent({ createdAt: 200, content: encContent({ groups: [], servers: [S1, S2] }) }),
      groups: [],
      servers: [S1, S2],
    });

    const result = renderUpdate();
    await act(async () => {
      await result.current.mutateAsync({ type: "add-server", url: S3 });
    });

    const items = decodePublished();
    // The stale relay copy must not revert S2.
    expect(items).toContainEqual(["r", S1]);
    expect(items).toContainEqual(["r", S2]);
    expect(items).toContainEqual(["r", S3]);
  });

  it("bases the edit on a newer ArmadaDB copy cached while the WebView was stopped", async () => {
    h.query.mockResolvedValue([
      listEvent({ createdAt: 100, content: encContent({ groups: [], servers: [S1] }) }),
    ]);
    h.storeQuery.mockResolvedValue([
      listEvent({ createdAt: 200, content: encContent({ groups: [], servers: [S1, S2] }) }),
    ]);

    const result = renderUpdate();
    await act(async () => {
      await result.current.mutateAsync({ type: "add-server", url: S3 });
    });

    expect(decodePublished()).toEqual(expect.arrayContaining([
      ["r", S1],
      ["r", S2],
      ["r", S3],
    ]));
  });

  it("keeps a public-tag list public (Flotilla interop) and needs no NIP-44 signer for it", async () => {
    // A list another client published as PLAIN PUBLIC TAGS, plus an unrelated
    // tag that must survive the rewrite.
    h.query.mockResolvedValue([
      listEvent({
        createdAt: 100,
        content: "",
        tags: [["r", S1], ["group", "chan", S1], ["title", "my groups"]],
      }),
    ]);
    // Signer without nip44: a public write must not require encryption.
    h.user = { pubkey: SELF, signer: {} };

    const result = renderUpdate();
    await act(async () => {
      await result.current.mutateAsync({ type: "add-server", url: S2 });
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const arg = h.publish.mock.calls[0][0] as { content: string; tags: string[][] };
    expect(arg.content).toBe("");
    expect(arg.tags).toContainEqual(["r", S1]);
    expect(arg.tags).toContainEqual(["r", S2]);
    expect(arg.tags).toContainEqual(["group", "chan", S1]);
    expect(arg.tags).toContainEqual(["title", "my groups"]);
  });

  it("keeps an encrypted list encrypted (never downgrades private items to public)", async () => {
    h.query.mockResolvedValue([
      listEvent({ createdAt: 100, content: encContent({ groups: [], servers: [S1] }) }),
    ]);

    const result = renderUpdate();
    await act(async () => {
      await result.current.mutateAsync({ type: "add-server", url: S2 });
    });

    const arg = h.publish.mock.calls[0][0] as { content: string; tags: string[][] };
    expect(arg.content.startsWith("enc:")).toBe(true);
    expect(arg.tags.filter(([n]) => n === "r" || n === "group")).toEqual([]);
    expect(decodePublished()).toContainEqual(["r", S2]);
  });

  it("refuses when the existing private items cannot be decrypted", async () => {
    h.query.mockResolvedValue([
      listEvent({ createdAt: 100, content: "garbage-not-ours" }),
    ]);

    const result = renderUpdate();
    await act(async () => {
      await expect(
        result.current.mutateAsync({ type: "add-server", url: S2 }),
      ).rejects.toThrow(/decryption failed/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("add-group carries the channel's server into the list (explicit join persists both)", async () => {
    h.query.mockResolvedValue([
      listEvent({ createdAt: 100, content: encContent({ groups: [], servers: [] }) }),
    ]);

    const result = renderUpdate();
    await act(async () => {
      await result.current.mutateAsync({ type: "add-group", ref: { id: "chan", relay: S1 } });
    });

    const items = decodePublished();
    expect(items).toContainEqual(["group", "chan", S1]);
    expect(items).toContainEqual(["r", S1]);
  });

  /**
   * Removing several servers in a row fires several read-modify-writes at
   * once — one per context-menu click, each spanning a network read, a signer
   * round-trip and a publish. Unserialized they all read the SAME pre-edit
   * list, each drops only its own server, and the last publish to land
   * reinstates the other four.
   */
  describe("concurrent writes", () => {
    const ALL = [S1, S2, S3, S4, S5];

    /** A relay that never updates, plus a persisted copy that carries writes forward. */
    function statefulBackend(servers: string[]) {
      h.query.mockResolvedValue([
        listEvent({ createdAt: 100, content: encContent({ groups: [], servers }) }),
      ]);
      let persisted: { event: NostrEvent; groups: GroupRef[]; servers: string[] } | undefined;
      h.readFolded.mockImplementation(async () => persisted);
      h.writeFolded.mockImplementation(async (_key, value) => {
        persisted = value as typeof persisted;
      });
      h.publish.mockImplementation(async (t) => {
        const tmpl = t as { created_at?: number; content: string; tags: string[][]; kind: number };
        return {
          ...tmpl,
          id: `p${++evCounter}`.padEnd(64, "0").slice(0, 64),
          pubkey: SELF,
          created_at: tmpl.created_at ?? 0,
          sig: "s".repeat(128),
        } as NostrEvent;
      });
    }

    /** The `r` tags of the last event published. */
    function lastPublishedServers(): string[] {
      const arg = h.publish.mock.calls.at(-1)![0] as { content: string };
      const items = JSON.parse(arg.content.slice(4)) as string[][];
      return items.filter(([n]) => n === "r").map(([, url]) => url);
    }

    it("loses no removal when five servers are removed at once", async () => {
      statefulBackend(ALL);

      const result = renderUpdate();
      await act(async () => {
        await Promise.all(
          ALL.map((url) => result.current.mutateAsync({ type: "remove-server", url })),
        );
      });

      expect(h.publish).toHaveBeenCalledTimes(5);
      // Every one of the five is gone from the final list — not just the last.
      expect(lastPublishedServers()).toEqual([]);
    });

    it("keeps a concurrent add from reinstating a removed server", async () => {
      statefulBackend([S1, S2]);

      const result = renderUpdate();
      await act(async () => {
        await Promise.all([
          result.current.mutateAsync({ type: "remove-server", url: S1 }),
          result.current.mutateAsync({ type: "add-server", url: S3 }),
        ]);
      });

      const servers = lastPublishedServers();
      expect(servers).not.toContain(S1);
      expect(servers).toContain(S2);
      expect(servers).toContain(S3);
    });

    it("advances created_at on every write so same-second edits can't tie", async () => {
      statefulBackend(ALL);

      const result = renderUpdate();
      await act(async () => {
        await Promise.all(
          ALL.map((url) => result.current.mutateAsync({ type: "remove-server", url })),
        );
      });

      // Replaceable events are ordered at second granularity and NIP-01 breaks
      // a tie by lowest id, so equal created_at lets an earlier edit win.
      const stamps = h.publish.mock.calls.map(
        ([t]) => (t as { created_at: number }).created_at,
      );
      expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
      expect(new Set(stamps).size).toBe(stamps.length);
    });

    it("purges the rail-arrangement key when a server is removed", async () => {
      statefulBackend([S1, S2]);

      const result = renderUpdate();
      await act(async () => {
        await result.current.mutateAsync({ type: "remove-server", url: S1 });
      });

      // Removal has to hit the arrangement as well as the list, or the key
      // survives in railLayout/railOrder and a later re-add drops the server
      // back into the folder it used to live in.
      expect(h.removeRailKey).toHaveBeenCalledWith(S1);
    });

    it("normalizes the rail key it purges, so a raw url still matches", async () => {
      statefulBackend([S1]);

      const result = renderUpdate();
      await act(async () => {
        await result.current.mutateAsync({ type: "remove-server", url: "wss://one.example" });
      });

      // The rail keys servers by NORMALIZED url; purging the raw form would
      // silently miss.
      expect(h.removeRailKey).toHaveBeenCalledWith(S1);
    });

    it("leaves the arrangement alone when a server is ADDED", async () => {
      statefulBackend([S1]);

      const result = renderUpdate();
      await act(async () => {
        await result.current.mutateAsync({ type: "add-server", url: S2 });
      });

      // A new server is appended by mergeLayout at render time; nothing to prune.
      expect(h.removeRailKey).not.toHaveBeenCalled();
    });
  });
});

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
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUpdateUserGroupList } from "@/hooks/useUserGroupList";
import { buildGroupListTags, type GroupRef } from "@/lib/nip29";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const S1 = normalizeRelayUrl("wss://one.example")!;
const S2 = normalizeRelayUrl("wss://two.example")!;
const S3 = normalizeRelayUrl("wss://three.example")!;

const h = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readFolded: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  writeFolded: vi.fn<(...args: unknown[]) => Promise<void>>(),
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { query: h.query } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));
vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
}));
// Only the read hook touches the event store; keep the module graph light.
vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => new Promise(() => undefined),
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
  h.user = { pubkey: SELF, signer: { nip44 } };
  h.publish.mockImplementation(async (t) => ({
    ...(t as object),
    id: "b".repeat(64),
    pubkey: SELF,
    created_at: 9999,
    sig: "s".repeat(128),
  }));
});

describe("useUpdateUserGroupList (kind 10009 read-modify-write)", () => {
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
});

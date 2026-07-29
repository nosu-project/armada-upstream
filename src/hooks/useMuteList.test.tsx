/**
 * Regression tests for the kind-10000 mute-list wipe hazard.
 *
 * useMuteUser is an explicit action, but it is a read-modify-write against a
 * replaceable event: if the read comes back empty while the user HAS a mute
 * list (cold pool, AUTH, wrong relay set), appending to "nothing" publishes a
 * list containing only the new mute — wiping the real one everywhere. The
 * locally-persisted mute cache is the safety net: refuse instead. See
 * AGENTS.md "Never publish a user's Nostr lists without an explicit user
 * action" (the refuse-on-empty-read clause).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMuteUser } from "@/hooks/useMuteList";

import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

const SELF = "a".repeat(64);
const TARGET = "b".repeat(64);
const EXISTING_PUBLIC = "c".repeat(64);
const EXISTING_PRIVATE = "d".repeat(64);

const h = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<NostrEvent[]>>(),
  publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readFolded: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  writeFolded: vi.fn<(...args: unknown[]) => Promise<void>>(),
  user: undefined as unknown,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { group: () => ({ query: h.query }) } }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://app.example/"] } }),
}));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish }),
}));
vi.mock("@/lib/foldedCache", () => ({
  readFolded: (...args: unknown[]) => h.readFolded(...args),
  writeFolded: (...args: unknown[]) => h.writeFolded(...args),
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
function muteEvent(opts: { tags?: string[][]; privateTags?: string[][] }): NostrEvent {
  return {
    id: `mute${++evCounter}`.padEnd(64, "0").slice(0, 64),
    pubkey: SELF,
    created_at: 1000,
    kind: 10000,
    tags: opts.tags ?? [],
    content: opts.privateTags ? `enc:${JSON.stringify(opts.privateTags)}` : "",
    sig: "f".repeat(128),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  h.query.mockReset();
  h.publish.mockReset().mockResolvedValue(undefined);
  h.readFolded.mockReset().mockResolvedValue(undefined);
  h.writeFolded.mockReset().mockResolvedValue(undefined);
  h.user = { pubkey: SELF, signer: { nip44 } };
});

describe("useMuteUser (kind 10000 read-modify-write)", () => {
  it("hides the peer optimistically before relay and signer work finishes", async () => {
    let resolveQuery!: (events: NostrEvent[]) => void;
    h.query.mockImplementation(
      () => new Promise<NostrEvent[]>((resolve) => { resolveQuery = resolve; }),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const queryKey = ["mute-list", SELF, "wss://app.example/"];
    client.setQueryData(queryKey, [EXISTING_PUBLIC]);
    const testWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useMuteUser(), { wrapper: testWrapper });
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.mutateAsync(TARGET);
      await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
    });

    expect(client.getQueryData(queryKey)).toEqual([EXISTING_PUBLIC, TARGET]);

    resolveQuery([
      muteEvent({ tags: [["p", EXISTING_PUBLIC]], privateTags: [] }),
    ]);
    await act(async () => {
      await pending!;
    });

    expect(client.getQueryData(queryKey)).toEqual([EXISTING_PUBLIC, TARGET]);
    expect(h.writeFolded).toHaveBeenCalledWith(
      `mute-pubkeys:${SELF}`,
      [EXISTING_PUBLIC, TARGET],
    );
  });

  it("restores the previous visible list when muting fails", async () => {
    h.query.mockRejectedValue(new Error("relay unavailable"));

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const queryKey = ["mute-list", SELF, "wss://app.example/"];
    client.setQueryData(queryKey, [EXISTING_PUBLIC]);
    const testWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useMuteUser(), { wrapper: testWrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow("relay unavailable");
    });

    expect(client.getQueryData(queryKey)).toEqual([EXISTING_PUBLIC]);
  });

  it("REFUSES to mute on an empty read when a cached mute list exists (the wipe)", async () => {
    h.query.mockResolvedValue([]);
    h.readFolded.mockResolvedValue([EXISTING_PRIVATE]); // this device knows a list existed

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow(/not muting/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("starts a fresh list when no mute list has ever existed", async () => {
    h.query.mockResolvedValue([]);
    h.readFolded.mockResolvedValue(undefined);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    expect(h.publish).toHaveBeenCalledTimes(1);
    const arg = h.publish.mock.calls[0][0] as { content: string };
    const privateTags = JSON.parse(arg.content.slice(4)) as string[][];
    expect(privateTags).toContainEqual(["p", TARGET]);
  });

  it("appends to the existing list, preserving public and private items", async () => {
    h.query.mockResolvedValue([
      muteEvent({ tags: [["p", EXISTING_PUBLIC]], privateTags: [["p", EXISTING_PRIVATE]] }),
    ]);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(TARGET);
    });

    const arg = h.publish.mock.calls[0][0] as { content: string; tags: string[][] };
    // Public portion untouched (format preserved), private portion appended.
    expect(arg.tags).toContainEqual(["p", EXISTING_PUBLIC]);
    const privateTags = JSON.parse(arg.content.slice(4)) as string[][];
    expect(privateTags).toContainEqual(["p", EXISTING_PRIVATE]);
    expect(privateTags).toContainEqual(["p", TARGET]);
  });

  it("refuses when the existing private items cannot be decrypted", async () => {
    h.query.mockResolvedValue([
      { ...muteEvent({}), content: "garbage-not-ours" },
    ]);

    const { result } = renderHook(() => useMuteUser(), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(TARGET)).rejects.toThrow(/avoid losing/i);
    });
    expect(h.publish).not.toHaveBeenCalled();
  });
});

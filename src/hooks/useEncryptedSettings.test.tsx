import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { EncryptedSettings } from "@/lib/schemas";

import { readStoredSettings, useEncryptedSettings } from "./useEncryptedSettings";

const PUBKEY = "a".repeat(64);

/**
 * A store with the one behaviour this hook leans on: NIP-01 addressable
 * supersession. Only a strictly newer version replaces the coordinate, which is
 * what makes "the document on disk" mean "the newest one seen from any source".
 */
class FakeStore {
  rumors: NostrRumor[] = [];

  async event(event: NostrEvent): Promise<void> {
    const { sig: _sig, ...rumor } = event;
    const coord = `${rumor.kind}:${rumor.pubkey}:${dTagOf(rumor) ?? ""}`;
    const index = this.rumors.findIndex(
      (held) => `${held.kind}:${held.pubkey}:${dTagOf(held) ?? ""}` === coord,
    );
    if (index === -1) {
      this.rumors.push(rumor);
      return;
    }
    if (rumor.created_at > this.rumors[index]!.created_at) this.rumors[index] = rumor;
  }

  async query([filter]: NostrFilter[]): Promise<NostrRumor[]> {
    return this.rumors.filter(
      (rumor) =>
        filter!.kinds!.includes(rumor.kind)
        && filter!.authors!.includes(rumor.pubkey)
        && filter!["#d"]!.includes(dTagOf(rumor) ?? ""),
    );
  }

  async count() {
    return { count: this.rumors.length };
  }
  async remove() {}
  async close() {}
}

function dTagOf(rumor: NostrRumor): string | undefined {
  return rumor.tags.find(([name]) => name === "d")?.[1];
}

let store: FakeStore;
let published: NostrEvent[];
let signed: number;

/** NIP-44 stand-in: reversible, and obviously not a real ciphertext. */
const signer = {
  nip44: {
    encrypt: async (_pubkey: string, plaintext: string) => `sealed:${plaintext}`,
    decrypt: async (_pubkey: string, ciphertext: string) => ciphertext.replace(/^sealed:/, ""),
  },
  signEvent: async (template: Omit<NostrEvent, "id" | "pubkey" | "sig">) => ({
    ...template,
    id: `event-${++signed}`,
    pubkey: PUBKEY,
    sig: "sig",
  }),
};

const h = vi.hoisted(() => ({ nostrEvent: vi.fn() }));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: { event: h.nostrEvent } }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: PUBKEY, signer } }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve(store),
}));

/** Put a settings document on disk the way the wire would. */
async function seedStore(settings: EncryptedSettings, createdAt: number): Promise<void> {
  await store.event({
    id: `stored-${createdAt}`,
    pubkey: PUBKEY,
    kind: 30078,
    created_at: createdAt,
    content: `sealed:${JSON.stringify(settings)}`,
    tags: [["d", "armada/metadata"]],
    sig: "sig",
  });
}

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHook(() => useEncryptedSettings(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** The plaintext of the settings event published by the n-th write. */
function publishedSettings(index = 0): EncryptedSettings {
  return JSON.parse(published[index]!.content.replace(/^sealed:/, ""));
}

beforeEach(() => {
  store = new FakeStore();
  published = [];
  signed = 0;
  h.nostrEvent.mockReset().mockImplementation((event: NostrEvent) => {
    published.push(event);
    return Promise.resolve();
  });
});

describe("readStoredSettings", () => {
  it("returns the newest document on disk", async () => {
    await seedStore({ theme: "light" }, 100);
    await seedStore({ theme: "dark" }, 200);

    const read = await readStoredSettings(store as never, signer as never, PUBKEY);
    expect(read?.settings).toEqual({ theme: "dark" });
    expect(read?.event.created_at).toBe(200);
  });

  it("returns null when the store holds nothing", async () => {
    expect(await readStoredSettings(store as never, signer as never, PUBKEY)).toBeNull();
  });

  it("returns null rather than a partial document when the payload is unreadable", async () => {
    await store.event({
      id: "garbage",
      pubkey: PUBKEY,
      kind: 30078,
      created_at: 100,
      content: "not even sealed",
      tags: [["d", "armada/metadata"]],
      sig: "sig",
    });

    expect(await readStoredSettings(store as never, signer as never, PUBKEY)).toBeNull();
  });
});

describe("useEncryptedSettings", () => {
  it("reads the settings document out of the store", async () => {
    await seedStore({ theme: "light", railOrder: ["a"] }, 100);

    const { result } = render();
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    expect(result.current.settings).toEqual({ theme: "light", railOrder: ["a"] });
  });

  it("merges a patch over the document ON DISK, not over the one it last read", async () => {
    await seedStore({ theme: "light" }, 100);

    const { result } = render();
    await waitFor(() => expect(result.current.settings).toEqual({ theme: "light" }));

    // Another device publishes; the standing REQ (or, on Android, the
    // notification service) files it while this query still holds the old one.
    await seedStore({ theme: "light", defaultZapAmount: 42 }, 200);

    await act(async () => {
      await result.current.updateSettings({ theme: "dark" });
    });

    expect(publishedSettings()).toMatchObject({ theme: "dark", defaultZapAmount: 42 });
  });

  it("publishes a version the store will accept over the one it merged over", async () => {
    // A document stamped in the future: `Date.now()` alone would be older, and
    // the store would silently refuse the write.
    const ahead = Math.floor(Date.now() / 1000) + 3600;
    await seedStore({ theme: "light" }, ahead);

    const { result } = render();
    await waitFor(() => expect(result.current.settings).toEqual({ theme: "light" }));

    await act(async () => {
      await result.current.updateSettings({ theme: "dark" });
    });

    expect(published[0]!.created_at).toBe(ahead + 1);
    const onDisk = await readStoredSettings(store as never, signer as never, PUBKEY);
    expect(onDisk?.settings).toMatchObject({ theme: "dark" });
  });

  it("stores the new document before publishing it", async () => {
    await seedStore({ theme: "light" }, 100);
    h.nostrEvent.mockImplementation(async (event: NostrEvent) => {
      // Whatever a relay does with it, it is already durable here.
      const onDisk = await readStoredSettings(store as never, signer as never, PUBKEY);
      expect(onDisk?.event.id).toBe(event.id);
      published.push(event);
      throw new Error("relay unreachable");
    });

    const { result } = render();
    await waitFor(() => expect(result.current.settings).toEqual({ theme: "light" }));

    await act(async () => {
      await result.current.updateSettings({ theme: "dark" });
    });

    expect(published).toHaveLength(1);
  });

  it("merges over nothing when the store is empty — callers must gate on that", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.settings).toBeNull();

    await act(async () => {
      await result.current.updateSettings({ theme: "dark" });
    });

    const { lastSync: _lastSync, ...rest } = publishedSettings();
    expect(rest).toEqual({ theme: "dark" });
  });
});

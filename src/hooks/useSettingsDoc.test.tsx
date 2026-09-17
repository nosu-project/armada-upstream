import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

import type { NostrRumor } from "@/lib/nostrRumor";
import { settingsDTag, type SettingsDocName } from "@/lib/settingsDocs";
import * as publishOutbox from "@/lib/publishOutbox";

import { readSettingsDoc, useSettingsDoc } from "./useSettingsDoc";

const PUBKEY = "a".repeat(64);

/**
 * A store with the one behaviour these hooks lean on: NIP-01 addressable
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

const h = vi.hoisted(() => ({
  nostrEvent: vi.fn(),
  relay: vi.fn(),
  config: {
    useAppRelays: true,
    appRelays: ["wss://app.example"],
    useUserRelays: false,
    relayMetadata: {
      pubkey: "a".repeat(64),
      updatedAt: 1,
      relays: [{ url: "wss://home.example", read: true, write: true }],
    },
  },
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({
    nostr: {
      relay: h.relay,
    },
  }),
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: PUBKEY, signer } }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => Promise.resolve(store),
}));

/** Put a settings document on disk the way the wire would. */
async function seedStore(
  name: SettingsDocName,
  doc: Record<string, unknown>,
  createdAt: number,
): Promise<void> {
  await store.event({
    id: `stored-${name}-${createdAt}`,
    pubkey: PUBKEY,
    kind: 30078,
    created_at: createdAt,
    content: `sealed:${JSON.stringify(doc)}`,
    tags: [["d", settingsDTag(name)]],
    sig: "sig",
  });
}

function render<N extends SettingsDocName>(name: N) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHook(() => useSettingsDoc(name), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** The plaintext of the settings event published by the n-th write. */
function publishedDoc(index = 0): Record<string, unknown> {
  return JSON.parse(published[index]!.content.replace(/^sealed:/, ""));
}

beforeEach(() => {
  store = new FakeStore();
  published = [];
  signed = 0;
  h.config.useAppRelays = true;
  h.config.appRelays = ["wss://app.example"];
  h.config.useUserRelays = false;
  h.config.relayMetadata = {
    pubkey: PUBKEY,
    updatedAt: 1,
    relays: [{ url: "wss://home.example", read: true, write: true }],
  };
  h.nostrEvent.mockReset().mockImplementation((event: NostrEvent) => {
    if (!published.some((held) => held.id === event.id)) published.push(event);
    return Promise.resolve();
  });
  h.relay.mockReset().mockImplementation(() => ({ event: h.nostrEvent }));
});

describe("readSettingsDoc", () => {
  it("returns the newest document on disk", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    await seedStore("metadata", { theme: "dark" }, 200);

    const read = await readSettingsDoc(store as never, signer as never, PUBKEY, "metadata");
    expect(read?.doc).toEqual({ theme: "dark" });
    expect(read?.event.created_at).toBe(200);
  });

  it("returns null when the store holds nothing", async () => {
    expect(
      await readSettingsDoc(store as never, signer as never, PUBKEY, "metadata"),
    ).toBeNull();
  });

  it("returns null rather than a partial document when the payload is unreadable", async () => {
    await store.event({
      id: "garbage",
      pubkey: PUBKEY,
      kind: 30078,
      created_at: 100,
      content: "not even sealed",
      tags: [["d", settingsDTag("metadata")]],
      sig: "sig",
    });

    expect(
      await readSettingsDoc(store as never, signer as never, PUBKEY, "metadata"),
    ).toBeNull();
  });

  /**
   * The whole point of the split: the documents are separate NIP-01
   * coordinates, so a read of one can neither see nor disturb another.
   */
  it("reads only its own document", async () => {
    await seedStore("metadata", { theme: "dark" }, 100);
    await seedStore("rail", { railLayout: [{ type: "item", key: "wss://a" }] }, 100);

    const rail = await readSettingsDoc(store as never, signer as never, PUBKEY, "rail");
    expect(rail?.doc).toEqual({ railLayout: [{ type: "item", key: "wss://a" }] });

    const readState = await readSettingsDoc(
      store as never,
      signer as never,
      PUBKEY,
      "read-state",
    );
    expect(readState).toBeNull();
  });
});

describe("useSettingsDoc", () => {
  it("reads the document out of the store", async () => {
    await seedStore("metadata", { theme: "light", zapsEnabled: false }, 100);

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).not.toBeNull());
    expect(result.current.doc).toEqual({ theme: "light", zapsEnabled: false });
  });

  it("merges a patch over the document ON DISK, not over the one it last read", async () => {
    await seedStore("metadata", { theme: "light" }, 100);

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    // Another device publishes; the standing REQ (or, on Android, the
    // notification service) files it while this query still holds the old one.
    await seedStore("metadata", { theme: "light", currencyDisplay: "sats" }, 200);

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    expect(publishedDoc()).toMatchObject({ theme: "dark", currencyDisplay: "sats" });
  });

  it("publishes to NIP-65 write relays even when general user-relay routing is off", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    expect(h.relay).toHaveBeenCalledWith("wss://app.example");
    expect(h.relay).toHaveBeenCalledWith("wss://home.example");
  });

  it("publishes a version the store will accept over the one it merged over", async () => {
    // A document stamped in the future: `Date.now()` alone would be older, and
    // the store would silently refuse the write.
    const ahead = Math.floor(Date.now() / 1000) + 3600;
    await seedStore("metadata", { theme: "light" }, ahead);

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    expect(published[0]!.created_at).toBe(ahead + 1);
    const onDisk = await readSettingsDoc(store as never, signer as never, PUBKEY, "metadata");
    expect(onDisk?.doc).toMatchObject({ theme: "dark" });
  });

  it("stores the new document before publishing it", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    h.nostrEvent.mockImplementation(async (event: NostrEvent) => {
      // Whatever a relay does with it, it is already durable here.
      const onDisk = await readSettingsDoc(store as never, signer as never, PUBKEY, "metadata");
      expect(onDisk?.event.id).toBe(event.id);
      if (!published.some((held) => held.id === event.id)) published.push(event);
      throw new Error("relay unreachable");
    });

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await expect(result.current.update({ theme: "dark" })).rejects.toThrow(/queued for retry/i);
    });

    expect(published).toHaveLength(1);
  });

  it("does not claim a failed delivery was queued when durable storage failed", async () => {
    await seedStore("metadata", { theme: "light" }, 100);
    const queue = vi.spyOn(publishOutbox, "queueSignedEvent")
      .mockRejectedValue(new Error("outbox unavailable"));
    h.nostrEvent.mockRejectedValue(new Error("relay unreachable"));

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).toEqual({ theme: "light" }));

    await act(async () => {
      await expect(result.current.update({ theme: "dark" }))
        .rejects.toThrow(/No account relay accepted/);
    });
    queue.mockRestore();
  });

  it("refuses to spill private settings into generic routing with no account relay", async () => {
    h.config.useAppRelays = false;
    h.config.relayMetadata = { pubkey: PUBKEY, updatedAt: 1, relays: [] };
    const { result } = render("metadata");
    await waitFor(() => expect(result.current.isFetched).toBe(true));

    await act(async () => {
      await expect(result.current.update({ theme: "dark" })).rejects.toThrow(/account write relay/);
    });
    expect(h.nostrEvent).not.toHaveBeenCalled();
  });

  it("merges over nothing when the store is empty — callers must gate on that", async () => {
    const { result } = render("metadata");
    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.doc).toBeNull();

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    const { lastSync: _lastSync, ...rest } = publishedDoc();
    expect(rest).toEqual({ theme: "dark" });
  });

  it("writes each document under its own `d` tag", async () => {
    const { result } = render("rail");
    await waitFor(() => expect(result.current.isFetched).toBe(true));

    await act(async () => {
      await result.current.update({ railLayout: [{ type: "item", key: "wss://a" }] });
    });

    expect(dTagOf(published[0]! as NostrRumor)).toBe(settingsDTag("rail"));
    expect(publishedDoc()).toEqual({ railLayout: [{ type: "item", key: "wss://a" }] });
  });

  /**
   * `lastSync` is written only for older builds, which order metadata versions
   * by it rather than by `created_at`. Every split document postdates those
   * builds, so emitting it there would be cargo cult.
   */
  it("stamps lastSync on metadata only", async () => {
    const metadata = render("metadata");
    await waitFor(() => expect(metadata.result.current.isFetched).toBe(true));
    await act(async () => {
      await metadata.result.current.update({ theme: "dark" });
    });
    expect(publishedDoc()).toHaveProperty("lastSync");

    const rail = render("rail");
    await waitFor(() => expect(rail.result.current.isFetched).toBe(true));
    await act(async () => {
      await rail.result.current.update({ railLayout: [] });
    });
    expect(publishedDoc(1)).not.toHaveProperty("lastSync");
  });

  /**
   * The half of the migration that makes the other half sound: a legacy field
   * left in metadata is only evidence that an OLD build wrote it if this build
   * never carries one forward. See `resolveLegacy` in `lib/settingsDocs.ts`.
   */
  it("strips migrated fields from every metadata write", async () => {
    await seedStore(
      "metadata",
      {
        theme: "light",
        railLayout: [{ type: "item", key: "wss://a" }],
        readState: { "wss://a::g": 5 },
        notifLevels: { "wss://a": "nothing" },
        pinnedDms: ["b".repeat(64)],
        frequentReactions: [{ key: "+", count: 3, usedAt: 1 }],
      },
      100,
    );

    const { result } = render("metadata");
    await waitFor(() => expect(result.current.doc).not.toBeNull());
    // It is still READ — that is what the migration window depends on.
    expect(result.current.doc?.railLayout).toHaveLength(1);

    await act(async () => {
      await result.current.update({ theme: "dark" });
    });

    const out = publishedDoc();
    expect(out).toMatchObject({ theme: "dark" });
    for (const key of [
      "railLayout",
      "railOrder",
      "readState",
      "notifLevels",
      "pinnedDms",
      "frequentReactions",
    ]) {
      expect(out).not.toHaveProperty(key);
    }
  });
});

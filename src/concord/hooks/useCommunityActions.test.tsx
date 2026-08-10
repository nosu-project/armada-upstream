/**
 * Channel creation with a repository attached (CORD-04 §2).
 *
 * A repository channel must be born attached. The attachment used to ride a
 * second `attachRepository` publish, which resolves the channel out of the
 * control fold — but `createChannel` only invalidates that fold in the
 * background, so the just-created channel was never in it and the follow-up
 * threw "Channel not found", leaving a plain text channel behind. These cover
 * the single-edition path under exactly that condition: an empty fold.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

import { mintCommunity } from "@/concord/lib/community";
import { STOCK_RELAYS } from "@/concord/lib/stockRelays";
import { MAX_COMMUNITY_RELAYS, withChannelGitRepositoryAttachments, type ChannelMetadata } from "@/concord/lib/types";
import { parseGitRepositoryAddress } from "@/lib/gitActivity";

import { defaultCreateRelays, useCommunityActions, useCommunityManagement } from "./useCommunityActions";

import type { NUser } from "@nostrify/react/login";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  folded: undefined as unknown,
  editions: [] as Array<{ content: string; tags: string[][] }>,
  listWrites: [] as Array<Record<string, unknown>>,
  // Interleaved op log, for asserting durability ORDER (vault before edition).
  ops: [] as string[],
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: {} }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://relay.test"] } }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useControlFold: () => ({ data: h.folded }),
  useDissolved: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl: () => undefined,
  publishEdition: async (_pool: unknown, _c: unknown, _s: unknown, edition: { content: string; tags: string[][] }) => {
    h.editions.push(edition);
    h.ops.push(`edition:${edition.tags.find((t) => t[0] === "vsk")?.[1]}`);
  },
}));
vi.mock("@/concord/hooks/useCommunityList", () => ({
  useCommunityEntry: () => undefined,
  useUpdateCommunityList: () => ({
    mutateAsync: async (write: Record<string, unknown>) => {
      h.listWrites.push(write);
      h.ops.push(`list:${write.type}`);
    },
  }),
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbookPublisher: () => ({ mutateAsync: async () => undefined }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER = "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47";
const COORDINATE = `30617:${OWNER}:armada`;
const RELAY_HINTS = ["wss://relay.ngit.dev", "wss://git.shakespeare.diy"];

const { community } = mintCommunity("Fleet", OWNER, ["wss://relay.test"]);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function metadataOf(edition: { content: string }): ChannelMetadata {
  return JSON.parse(edition.content) as ChannelMetadata;
}

function attachmentsOf(metadata: ChannelMetadata): Array<Record<string, unknown>> {
  const custom = metadata.custom as Record<string, unknown> | undefined;
  const extension = custom?.["armada.git"] as { repositories?: Array<Record<string, unknown>> } | undefined;
  return extension?.repositories ?? [];
}

beforeEach(() => {
  h.editions = [];
  h.listWrites = [];
  h.ops = [];
  // The regression condition: the fold has not caught up with the new channel.
  h.folded = undefined;
  h.user = { pubkey: OWNER, signer: { nip44: {} } } as unknown as NUser;
});

describe("createChannel with a repository", () => {
  it("publishes ONE edition carrying the attachment even when the fold is empty", async () => {
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await result.current.createChannel({
      name: "armada",
      repository: { address: COORDINATE, relayHints: RELAY_HINTS },
    });

    await waitFor(() => expect(h.editions).toHaveLength(1));
    const metadata = metadataOf(h.editions[0]);
    expect(metadata.name).toBe("armada");

    const attachments = attachmentsOf(metadata);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].address).toBe(COORDINATE);
    expect(attachments[0].relayHints).toEqual(RELAY_HINTS);
    // Live interval: a detached attachment would hide the channel's Projects entry.
    expect(attachments[0].detachedAt).toBeUndefined();
    expect(attachments[0].attachedAt).toBeTypeOf("number");
  });

  it("leaves a plain channel free of Git metadata", async () => {
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await result.current.createChannel({ name: "general" });

    await waitFor(() => expect(h.editions).toHaveLength(1));
    const metadata = metadataOf(h.editions[0]);
    expect(metadata.name).toBe("general");
    expect(attachmentsOf(metadata)).toHaveLength(0);
  });

  it("refuses a non-canonical repository coordinate", async () => {
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await expect(
      result.current.createChannel({
        name: "armada",
        repository: { address: "naddr1notacoordinate", relayHints: RELAY_HINTS },
      }),
    ).rejects.toThrow(/canonical 30617 coordinate/);
    expect(h.editions).toHaveLength(0);
  });
});

describe("attachRepository", () => {
  const CHANNEL = "11".repeat(32);

  function foldWith(metadata: ChannelMetadata) {
    return {
      roster: {},
      channels: new Map([[CHANNEL, { metadata }]]),
      heads: new Map([[CHANNEL, { version: 1n, hash: undefined }]]),
    };
  }

  it("cannot see a channel the fold has not caught up with", async () => {
    // Why createChannel carries the repository itself: this is the exact
    // failure the wizard hit on a channel it had just published.
    h.folded = foldWith({ name: "armada", private: false });
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await expect(
      result.current.attachRepository({
        channelIdHex: "22".repeat(32),
        address: COORDINATE,
        relayHints: RELAY_HINTS,
      }),
    ).rejects.toThrow(/Channel not found/);
    expect(h.editions).toHaveLength(0);
  });

  it("attaches to a channel already in the fold", async () => {
    h.folded = foldWith({ name: "armada", private: false });
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await result.current.attachRepository({
      channelIdHex: CHANNEL,
      address: COORDINATE,
      relayHints: RELAY_HINTS,
    });

    await waitFor(() => expect(h.editions).toHaveLength(1));
    const attachments = attachmentsOf(metadataOf(h.editions[0]));
    expect(attachments).toHaveLength(1);
    expect(attachments[0].address).toBe(COORDINATE);
    expect(attachments[0].detachedAt).toBeUndefined();
  });

  it("is a no-op when the repository is already attached and live", async () => {
    const attached = withChannelGitRepositoryAttachments({ name: "armada", private: false }, [
      { address: parseGitRepositoryAddress(COORDINATE)!, relayHints: RELAY_HINTS, attachedAt: 1 },
    ]);
    h.folded = foldWith(attached);
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await result.current.attachRepository({
      channelIdHex: CHANNEL,
      address: COORDINATE,
      relayHints: RELAY_HINTS,
    });

    // A duplicate interval would restart the timeline window at "now" and hide
    // everything the channel had already shown.
    expect(h.editions).toHaveLength(0);
  });
});

// ── CORD-03 §2: Private → Public ─────────────────────────────────────────────

describe("publiciseChannel (CORD-03 §2, the reverse conversion)", () => {
  const CHANNEL = "cd".repeat(32);

  beforeEach(() => {
    h.folded = {
      channels: new Map([
        [CHANNEL, { channelIdHex: CHANNEL, name: "was-secret", isPrivate: true, deleted: false, metadata: { name: "was-secret", private: true } }],
      ]),
      heads: new Map(),
      ownerHex: OWNER,
      roster: { roles: [], grants: [] },
    };
  });

  it("O-19: flips a private channel back to public", async () => {
    // "Converting Private to Public reverses it: the Channel begins deriving
    // from the community_root going forward." A client that can only privatise
    // makes the conversion a one-way door — there is no way back from a
    // mis-privatised channel, and the spec provides for one.
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await result.current.publiciseChannel({ channelIdHex: CHANNEL });

    await waitFor(() => expect(h.editions).toHaveLength(1));
    expect(metadataOf(h.editions[0]).private).toBe(false);
    // Round-trips everything the conversion doesn't touch (CORD-02 §6).
    expect(metadataOf(h.editions[0]).name).toBe("was-secret");
  });

  it("refuses a channel that is already public", async () => {
    (h.folded as { channels: Map<string, unknown> }).channels.set(CHANNEL, {
      channelIdHex: CHANNEL, name: "open", isPrivate: false, deleted: false, metadata: { name: "open", private: false },
    });
    const { result } = renderHook(() => useCommunityManagement(community), { wrapper });

    await expect(result.current.publiciseChannel({ channelIdHex: CHANNEL })).rejects.toThrow(/already public/i);
    expect(h.editions).toHaveLength(0);
  });
});

// ── Community genesis: the starter rooms ─────────────────────────────────────

describe("create — genesis plus the starter rooms", () => {
  const vskOf = (e: { tags: string[][] }) => e.tags.find((t) => t[0] === "vsk")?.[1];
  const eidOf = (e: { tags: string[][] }) => e.tags.find((t) => t[0] === "eid")?.[1];

  it("publishes a public #general and a private #private, its key vaulted before its edition", async () => {
    const { result } = renderHook(() => useCommunityActions(), { wrapper });

    await result.current.create({ name: "Fleet", relays: ["wss://relay.test"] });

    // Genesis metadata (vsk 0) + #general (2), then the follow-up starter
    // room: its access role (1) BEFORE its channel edition (2) — the
    // createChannel ordering, so a partial failure leaves the inert orphan.
    expect(h.editions.map(vskOf)).toEqual(["0", "2", "1", "2"]);
    expect(JSON.parse(h.editions[1].content)).toMatchObject({ name: "general", private: false });
    expect(JSON.parse(h.editions[3].content)).toMatchObject({ name: "private", private: true });

    // The access role: named after the channel, scoped to it, zero bits.
    const role = JSON.parse(h.editions[2].content);
    expect(role).toMatchObject({ name: "private", permissions: "0" });
    expect(role.scope).toEqual({ kind: "channel", channel_id: eidOf(h.editions[3]) });

    // The channel key rides the vault entry, and that write lands BEFORE the
    // channel exists on the wire — a lost list write must never orphan the
    // only copy of the key behind a live channel definition.
    const add = h.listWrites.find((w) => w.type === "add") as { entry: { current: { channels: Array<{ name?: string }> } } };
    expect(add.entry.current.channels).toHaveLength(1);
    expect(add.entry.current.channels[0].name).toBe("private");
    expect(h.ops.indexOf("list:add")).toBeLessThan(h.ops.indexOf("edition:1"));
  });

  /**
   * The creation wizard's second step (icon / banner / description) rides the
   * GENESIS edition rather than a follow-up update: version 1 is what a member
   * folds on first contact, and a second publish that never landed would leave
   * the community describing itself as the creator never saw it.
   */
  it("seals the wizard's presentation into the genesis metadata (CORD-02 §6)", async () => {
    const { result } = renderHook(() => useCommunityActions(), { wrapper });
    const icon = { url: "https://blossom.test/i.enc", key: "aa".repeat(32), nonce: "bb".repeat(16), hash: "cc".repeat(32) };
    const banner = { url: "https://blossom.test/b.enc", key: "dd".repeat(32), nonce: "ee".repeat(16), hash: "ff".repeat(32) };

    await result.current.create({
      name: "Fleet",
      relays: ["wss://relay.test"],
      description: "  Ships and the people who sail them.  ",
      icon,
      banner,
    });

    const metadata = JSON.parse(h.editions[0].content) as Record<string, unknown>;
    expect(metadata.description).toBe("Ships and the people who sail them.");
    expect(metadata.icon).toEqual(icon);
    expect(metadata.banner).toEqual(banner);
  });

  it("writes no presentation keys at all when the wizard's second step was left empty", async () => {
    const { result } = renderHook(() => useCommunityActions(), { wrapper });

    // Whitespace is not a description: an all-spaces field must leave the key
    // absent, not store a blank string every reader then has to trim.
    await result.current.create({ name: "Fleet", relays: ["wss://relay.test"], description: "   " });

    const metadata = JSON.parse(h.editions[0].content) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("description");
    expect(metadata).not.toHaveProperty("icon");
    expect(metadata).not.toHaveProperty("banner");
    expect(metadata.name).toBe("Fleet");
  });
});

// ── The home relays a new community is minted on ─────────────────────────────

/**
 * `communityRelays` is the WHOLE answer. App relays and the creator's NIP-17
 * DM relays used to be unioned in alongside an unconditional stock set, which
 * is how communities ended up hosted on relays their creator never picked and
 * could not see in any setting.
 */
describe("defaultCreateRelays", () => {
  it("uses the configured set verbatim, adding nothing", () => {
    expect(defaultCreateRelays(["wss://mine.example.com"])).toEqual(["wss://mine.example.com"]);
  });

  it("falls back to the stock set only when the list is empty", () => {
    expect(defaultCreateRelays([])).toEqual(STOCK_RELAYS);
  });

  it("drops ws:// so https members aren't locked out (#47)", () => {
    expect(defaultCreateRelays(["ws://localhost:5577", "wss://mine.example.com"])).toEqual([
      "wss://mine.example.com",
    ]);
  });

  it("dedupes and caps at the recommended community relay count", () => {
    const many = Array.from({ length: 8 }, (_, i) => `wss://r${i}.example.com`);
    expect(defaultCreateRelays([...many, many[0]])).toEqual(many.slice(0, MAX_COMMUNITY_RELAYS));
  });
});

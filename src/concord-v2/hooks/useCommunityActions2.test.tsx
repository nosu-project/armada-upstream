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

import { mintCommunity } from "@/concord-v2/lib/community";
import { withChannelGitRepositoryAttachments, type ChannelMetadata } from "@/concord-v2/lib/types";
import { parseGitRepositoryAddress } from "@/lib/gitActivity";

import { useCommunityManagement2 } from "./useCommunityActions2";

import type { NUser } from "@nostrify/react/login";

// ── Module mocks ─────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  user: undefined as unknown,
  folded: undefined as unknown,
  editions: [] as Array<{ content: string }>,
}));

vi.mock("@nostrify/react", () => ({
  useNostr: () => ({ nostr: {} }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/concord-v2/hooks/useControlPlane2", () => ({
  useControlFold2: () => ({ data: h.folded }),
  useDissolved2: () => ({ data: undefined }),
  citationFor: () => undefined,
  invalidateControl2: () => undefined,
  publishEdition2: async (_pool: unknown, _c: unknown, _s: unknown, edition: { content: string }) => {
    h.editions.push(edition);
  },
}));
vi.mock("@/concord-v2/hooks/useCommunityList2", () => ({
  useCommunityEntry2: () => undefined,
  useUpdateCommunityList2: () => ({ mutateAsync: async () => undefined }),
}));
vi.mock("@/concord-v2/hooks/useGuestbook2", () => ({
  useGuestbookPublisher2: () => ({ mutateAsync: async () => undefined }),
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
  // The regression condition: the fold has not caught up with the new channel.
  h.folded = undefined;
  h.user = { pubkey: OWNER, signer: {} } as unknown as NUser;
});

describe("createChannel with a repository", () => {
  it("publishes ONE edition carrying the attachment even when the fold is empty", async () => {
    const { result } = renderHook(() => useCommunityManagement2(community), { wrapper });

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
    const { result } = renderHook(() => useCommunityManagement2(community), { wrapper });

    await result.current.createChannel({ name: "general" });

    await waitFor(() => expect(h.editions).toHaveLength(1));
    const metadata = metadataOf(h.editions[0]);
    expect(metadata.name).toBe("general");
    expect(attachmentsOf(metadata)).toHaveLength(0);
  });

  it("refuses a non-canonical repository coordinate", async () => {
    const { result } = renderHook(() => useCommunityManagement2(community), { wrapper });

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
    const { result } = renderHook(() => useCommunityManagement2(community), { wrapper });

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
    const { result } = renderHook(() => useCommunityManagement2(community), { wrapper });

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
    const { result } = renderHook(() => useCommunityManagement2(community), { wrapper });

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

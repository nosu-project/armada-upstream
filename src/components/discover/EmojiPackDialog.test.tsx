import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmojiPackDialog } from "@/components/discover/EmojiPackDialog";

import type { NostrRumor } from "@/lib/nostrRumor";

const SELF = "a".repeat(64);

const h = vi.hoisted(() => ({
  publish: vi.fn<(t: { kind: number; content: string; tags: string[][] }) => Promise<unknown>>(),
  readOwn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: SELF } }) }));
vi.mock("@/hooks/useEventStore", () => ({ useEventStore: () => Promise.resolve({}) }));
vi.mock("@/hooks/useUploadFile", () => ({ useUploadFile: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publish, isPending: false }),
}));
vi.mock("@/hooks/useEmojiPacks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEmojiPacks")>()),
  readOwnEmojiPack: h.readOwn,
  useAddEmojiPack: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/components/chat/CustomEmoji", () => ({
  CustomEmojiImg: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock("@/components/ui/FallbackImage", () => ({ FallbackImage: () => null }));

function pack(tags: string[][]): NostrRumor {
  return {
    id: "b".repeat(64),
    pubkey: SELF,
    kind: 30030,
    tags: [
      ["d", "cats"],
      ["title", "Cats"],
      ["emoji", "one", "https://cdn.example/1.png"],
      ["emoji", "two", "https://cdn.example/2.png"],
      ["emoji", "three", "https://cdn.example/3.png"],
      ...tags,
    ],
    content: "",
    created_at: 1,
  } as NostrRumor;
}

function renderEdit(event: NostrRumor) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <EmojiPackDialog open onOpenChange={() => {}} editEvent={event} />
    </QueryClientProvider>,
  );
}

function publishedEmojiOrder(): string[] {
  const tags = h.publish.mock.calls[0][0].tags;
  return tags.filter((t) => t[0] === "emoji").map((t) => t[1]);
}

beforeEach(() => {
  h.publish.mockReset().mockImplementation(async (t) => ({ ...t, pubkey: SELF, created_at: 2, id: "c" }));
  h.readOwn.mockReset().mockResolvedValue(null);
});

describe("EmojiPackDialog (edit mode)", () => {
  it("keeps the identifier and the tags it doesn't manage, from the freshest copy", async () => {
    const opened = pack([]);
    h.readOwn.mockResolvedValue(pack([["t", "animals"], ["client", "Other"]]));
    renderEdit(opened);

    fireEvent.click(screen.getByRole("button", { name: /update pack/i }));
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));

    const { kind, tags } = h.publish.mock.calls[0][0];
    expect(kind).toBe(30030);
    expect(tags).toContainEqual(["d", "cats"]);
    expect(tags).toContainEqual(["t", "animals"]);
    expect(tags).toContainEqual(["client", "Other"]);
    expect(publishedEmojiOrder()).toEqual(["one", "two", "three"]);
  });

  it("reorders with the arrow keys on a row's handle, and publishes in that order", async () => {
    renderEdit(pack([]));

    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: /^move three/i }), { key: "ArrowUp" });
    });
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: /^move one/i }), { key: "ArrowDown" });
    });

    fireEvent.click(screen.getByRole("button", { name: /update pack/i }));
    await waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    expect(publishedEmojiOrder()).toEqual(["three", "one", "two"]);
  });
});

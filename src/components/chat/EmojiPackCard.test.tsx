import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { EXPANDED_STEP, EmojiPackCard } from "@/components/chat/EmojiPackCard";

import type { ReactNode } from "react";

import type { NostrRumor } from "@/lib/nostrRumor";

vi.mock("@/hooks/useEmojiPacks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEmojiPacks")>()),
  useHasEmojiPack: () => false,
  useAddEmojiPack: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveEmojiPack: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useNaddrLink", () => ({
  useNaddrLink: () => ({ naddr: undefined, copied: false, copy: vi.fn() }),
}));
vi.mock("@/components/chat/CustomEmoji", () => ({
  CustomEmojiImg: ({ name }: { name: string }) => <span data-testid="emoji">{name}</span>,
}));
vi.mock("@/components/ui/FallbackImage", () => ({
  FallbackImage: ({ src }: { src?: string }) => <span data-testid="policy-image">{src}</span>,
}));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <>{name}</> }));

function pack(count: number, extraTags: string[][] = []): NostrRumor {
  const emojis = Array.from({ length: count }, (_, i) => ["emoji", `e${i}`, `https://cdn.example/${i}.png`]);
  return {
    id: "b".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30030,
    tags: [["d", "big"], ["title", "Big"], ...extraTags, ...emojis],
    content: "",
    created_at: 1,
  } as NostrRumor;
}

function renderCard(event: NostrRumor, expanded = false) {
  render(
    <MemoryRouter>
      <EmojiPackCard event={event} expanded={expanded} />
    </MemoryRouter>,
  );
}

describe("EmojiPackCard", () => {
  it("loads the pack icon through the media-policy image, not a raw <img>", () => {
    renderCard(pack(1, [["image", "https://cdn.example/icon.png"]]));

    expect(screen.getByTestId("policy-image")).toHaveTextContent("https://cdn.example/icon.png");
    expect(document.querySelector("img")).toBeNull();
  });

  it("previews a fixed number of emojis with a +N count", () => {
    renderCard(pack(40));

    expect(screen.getAllByTestId("emoji")).toHaveLength(16);
    expect(screen.getByText("+24")).toBeInTheDocument();
  });

  it("grows the expanded grid a step at a time", () => {
    const total = EXPANDED_STEP * 2 + 50;
    renderCard(pack(total), true);

    expect(screen.getAllByTestId("emoji")).toHaveLength(EXPANDED_STEP);
    fireEvent.click(screen.getByRole("button", { name: /Show 200 more/ }));
    expect(screen.getAllByTestId("emoji")).toHaveLength(EXPANDED_STEP * 2);
    fireEvent.click(screen.getByRole("button", { name: /Show 50 more/ }));
    expect(screen.getAllByTestId("emoji")).toHaveLength(total);
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MediaHoldContext, type MediaHold } from "@/components/chat/mediaHold";
import { ReactionBar } from "./ReactionBar";

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/**
 * A custom-emoji pill shows the image a TRUSTED reactor named, never a held
 * one's — so a stranger can't paint a shortcode regulars use — and joining the
 * pill signs only the shown image.
 */

vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsTouch: () => false }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "Ana" }));
vi.mock("@/hooks/useFrequentReactions", () => ({ recordReaction: () => {}, useFrequentReactions: () => [] }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <>{name}</> }));
vi.mock("@/components/chat/CustomEmoji", () => ({
  CustomEmojiImg: ({ url }: { url: string }) => <img alt="" data-url={url} />,
}));

const SPAM = "f".repeat(64);
const ANA = "a".repeat(64);
const SPAM_URL = "https://spam.example/x.png";
const ANA_URL = "https://emoji.example/heart.png";

const holdSpam: MediaHold = { media: (pk) => pk === SPAM, avatar: (pk) => pk === SPAM, host: () => false };

function renderPill(tally: ReactionTally, onReact: (i: ReactInput) => void = () => {}) {
  return render(
    <MediaHoldContext.Provider value={holdSpam}>
      <ReactionBar tallies={[tally]} canReact onReact={onReact} />
    </MediaHoldContext.Provider>,
  );
}

describe("ReactionBar media hold", () => {
  it("shows the trusted reactor's image even when a held one reacted first", () => {
    const { container } = renderPill({
      key: ":heart:", url: SPAM_URL, count: 2, pubkeys: [SPAM, ANA], urls: [SPAM_URL, ANA_URL], mine: false,
    });
    expect(container.querySelector("img")?.getAttribute("data-url")).toBe(ANA_URL);
  });

  it("falls back to the shortcode when only held reactors named an image, and never re-signs it", () => {
    const onReact = vi.fn();
    const { container } = renderPill(
      { key: ":heart:", url: SPAM_URL, count: 1, pubkeys: [SPAM], urls: [SPAM_URL], mine: false },
      onReact,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(":heart:");
    fireEvent.click(screen.getByRole("button", { name: /:heart:/ }));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ key: ":heart:", emojiUrl: undefined }));
  });
});

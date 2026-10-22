import { render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import { EmbeddedEventCard } from "@/components/chat/EmbeddedNote";

import type { NostrRumor } from "@/lib/nostrRumor";

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const OWNER = "a".repeat(64);
const NPUB = nip19.npubEncode(OWNER);

function announcement(tags: string[][]): NostrRumor {
  return { id: "b".repeat(64), pubkey: OWNER, kind: 30617, tags, content: "", created_at: 1 };
}

describe("EmbeddedEventCard for a NIP-34 repository", () => {
  it("shows the name, description, topics and ngit remote, linking to GitWorkshop", () => {
    render(
      <EmbeddedEventCard
        event={announcement([
          ["d", "armada"],
          ["name", "Armada"],
          ["description", "Serverless communities"],
          ["relays", "wss://relay.ngit.dev"],
          ["t", "nostr"],
          ["t", "personal-fork"],
        ])}
      />,
    );

    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(screen.getByText("Armada")).toBeInTheDocument();
    expect(screen.getByText("Serverless communities")).toBeInTheDocument();
    expect(screen.getByText("nostr")).toBeInTheDocument();
    expect(screen.queryByText("personal-fork")).toBeNull();
    expect(screen.getByText(`nostr://${NPUB}/relay.ngit.dev/armada`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy clone URL" })).toBeInTheDocument();
    expect(screen.getByText("View on gitworkshop.dev")).toBeInTheDocument();
  });

  it("falls back to the identifier when the announcement names nothing", () => {
    render(<EmbeddedEventCard event={announcement([["d", "bare"]])} />);

    expect(screen.getByText("bare")).toBeInTheDocument();
    expect(screen.getByText(`nostr://${NPUB}/bare`)).toBeInTheDocument();
  });
});

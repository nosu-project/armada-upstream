import { render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NaddrPage } from "@/pages/NaddrPage";

import type { ReactNode } from "react";

import type { NostrRumor } from "@/lib/nostrRumor";

const h = vi.hoisted(() => ({
  addrEvent: vi.fn<(addr: unknown, relays?: string[]) => { data: unknown; isLoading: boolean }>(),
}));

vi.mock("@/hooks/useEvent", async (importOriginal) => ({
  publicRelayHints: (await importOriginal<typeof import("@/hooks/useEvent")>()).publicRelayHints,
  useAddrEvent: (addr: unknown, relays?: string[]) => h.addrEvent(addr, relays),
}));
vi.mock("@/hooks/useDiscover", () => ({ useDiscoverRelays: () => ["wss://discover.example"] }));
vi.mock("@/components/layout/DetailPage", () => ({
  DetailPage: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
vi.mock("@/components/chat/EmojiPackCard", () => ({
  EmojiPackCard: ({ expanded }: { expanded?: boolean }) => (
    <p>emoji pack card{expanded ? " (expanded)" : ""}</p>
  ),
}));
vi.mock("@/components/discover/ThemeDiscoverCard", () => ({
  ThemeDiscoverCard: () => <p>theme card</p>,
}));
vi.mock("@/components/chat/EmbeddedNote", () => ({
  EmbeddedEventCard: () => <p>generic event card</p>,
}));
vi.mock("@/pages/NotFound", () => ({ NotFound: () => <p>not found</p> }));

const PUBKEY = "a".repeat(64);

function naddr(kind: number, identifier = "x", relays: string[] = []) {
  return nip19.naddrEncode({ kind, pubkey: PUBKEY, identifier, relays });
}

function rumor(kind: number, tags: string[][]): NostrRumor {
  return { id: "b".repeat(64), pubkey: PUBKEY, kind, tags, content: "", created_at: 1 } as NostrRumor;
}

function renderAt(segment: string) {
  render(
    <MemoryRouter initialEntries={[`/${segment}`]}>
      <Routes>
        <Route path="/:user" element={<NaddrPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NaddrPage", () => {
  beforeEach(() => {
    h.addrEvent.mockReset().mockReturnValue({ data: null, isLoading: false });
  });

  it("renders a theme's preview and card", () => {
    h.addrEvent.mockReturnValue({
      data: rumor(36767, [
        ["d", "dusk"],
        ["title", "Dusk"],
        ["c", "#101018", "background"],
        ["c", "#f0f0f0", "text"],
        ["c", "#ff5500", "primary"],
      ]),
      isLoading: false,
    });
    renderAt(naddr(36767, "dusk", ["wss://hint.example", "ws://192.168.1.1", "wss://localhost"]));

    expect(screen.getByRole("heading", { name: "Dusk" })).toBeInTheDocument();
    expect(screen.getByLabelText("Preview of Dusk")).toBeInTheDocument();
    expect(screen.getByText("theme card")).toBeInTheDocument();
    // Our own Discover relays first, then the naddr's public relay hints; a
    // LAN or loopback hint is never dialed.
    expect(h.addrEvent).toHaveBeenCalledWith(
      { kind: 36767, pubkey: PUBKEY, identifier: "dusk" },
      ["wss://discover.example", "wss://hint.example"],
    );
  });

  it("renders an emoji pack expanded", () => {
    h.addrEvent.mockReturnValue({
      data: rumor(30030, [["d", "cats"], ["title", "Cats"]]),
      isLoading: false,
    });
    renderAt(naddr(30030, "cats"));

    expect(screen.getByText("emoji pack card (expanded)")).toBeInTheDocument();
  });

  it("falls back to the generic event card for any other kind", () => {
    h.addrEvent.mockReturnValue({
      data: rumor(30023, [["d", "post"], ["title", "A post"]]),
      isLoading: false,
    });
    renderAt(naddr(30023, "post"));

    expect(screen.getByRole("heading", { name: "A post" })).toBeInTheDocument();
    expect(screen.getByText("generic event card")).toBeInTheDocument();
  });

  it("falls back to the generic card for a theme whose colors don't parse", () => {
    h.addrEvent.mockReturnValue({ data: rumor(36767, [["d", "broken"]]), isLoading: false });
    renderAt(naddr(36767, "broken"));

    expect(screen.getByText("generic event card")).toBeInTheDocument();
    expect(screen.queryByText("theme card")).toBeNull();
  });

  it("says the event is missing when no relay has it", () => {
    renderAt(naddr(30030, "gone"));

    expect(screen.getByRole("heading", { name: "Missing emoji pack" })).toBeInTheDocument();
  });

  it.each(["naddr1notbech32", "naddr1"])("renders NotFound for an invalid naddr %s", (segment) => {
    renderAt(segment);

    expect(screen.getByText("not found")).toBeInTheDocument();
    expect(screen.queryByText("generic event card")).toBeNull();
  });
});

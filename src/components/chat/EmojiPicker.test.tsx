import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { EmojiPicker } from "./EmojiPicker";

import type { CustomEmoji } from "@/hooks/useCustomEmojis";

// emoji-mart is a custom element this suite never needs to draw.
vi.mock("emoji-mart", () => ({ Picker: class { constructor() { return document.createElement("div"); } }, Data: undefined }));
vi.mock("@emoji-mart/data", () => ({ default: {} }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));

const custom = [{ shortcode: "wave", url: "https://cdn.example/wave.png" }] as CustomEmoji[];

function renderPicker(props: Partial<Parameters<typeof EmojiPicker>[0]>) {
  return render(
    <MemoryRouter>
      <EmojiPicker onSelect={() => {}} onBrowsePacks={() => {}} {...props} />
    </MemoryRouter>,
  );
}

describe("EmojiPicker packs footer", () => {
  it("invites a user with no custom emoji to add packs", () => {
    renderPicker({});
    expect(screen.getByText("Add custom emoji packs")).toBeInTheDocument();
  });

  it("still links a user with custom emoji to more packs where the host has no link of its own", () => {
    renderPicker({ customEmojis: custom });
    expect(screen.getByText("Find more emoji packs")).toBeInTheDocument();
  });

  it("leaves the link to a host that carries its own once the user has custom emoji", () => {
    renderPicker({ customEmojis: custom, packsLinkInHost: true });
    expect(screen.queryByText(/emoji packs/)).not.toBeInTheDocument();
  });
});

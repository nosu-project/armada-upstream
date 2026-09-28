import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeSelector } from "./ThemeSelector";
import { THEME_DEFINITION_KIND } from "@/lib/themeEvent";

import type { NostrRumor } from "@/lib/nostrRumor";

const h = vi.hoisted(() => ({
  publishEvent: vi.fn(),
  toast: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publishEvent, isPending: false }),
}));
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "custom",
    customTheme: {
      title: "Sunset",
      colors: { background: "#100b15", text: "#ffffff", primary: "#ff6600" },
    },
    setTheme: vi.fn(),
    applyCustomTheme: vi.fn(),
  }),
}));
vi.mock("@/hooks/useUserThemes", () => ({
  useUserThemes: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { appRelays: ["wss://relay.example"] } }),
}));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: h.writeClipboardText }));
// The color picker paints on a canvas, which jsdom does not implement.
vi.mock("@/components/ui/color-picker", () => ({
  ColorPicker: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}));

const PUBLISHED = {
  id: "shared-theme-event",
  kind: THEME_DEFINITION_KIND,
  pubkey: "a".repeat(64),
  tags: [["d", "sunset-x1"]],
} as NostrRumor;

describe("ThemeSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.publishEvent.mockResolvedValue(PUBLISHED);
    h.writeClipboardText.mockResolvedValue(undefined);
  });

  it("offers the shared theme's link from the success toast", async () => {
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Share to Discover" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Theme shared" })),
    );
    const { action } = h.toast.mock.calls.find(([t]) => t.title === "Theme shared")![0];
    expect(action.props.children).toBe("Copy link");
    action.props.onClick();

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ title: "Link copied" }));
    const url: string = h.writeClipboardText.mock.calls[0][0];
    expect(url.startsWith(`${window.location.origin}/`)).toBe(true);
    expect(nip19.decode(url.slice(window.location.origin.length + 1))).toEqual({
      type: "naddr",
      data: {
        kind: THEME_DEFINITION_KIND,
        pubkey: "a".repeat(64),
        identifier: "sunset-x1",
        relays: ["wss://relay.example"],
      },
    });
  });

  it("reports a failed copy", async () => {
    h.writeClipboardText.mockRejectedValue(new Error("denied"));
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Share to Discover" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Theme shared" })),
    );
    h.toast.mock.calls.find(([t]) => t.title === "Theme shared")![0].action.props.onClick();

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith({ title: "Copy failed", variant: "destructive" }),
    );
  });
});

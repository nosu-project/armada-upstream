import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeSelector } from "./ThemeSelector";

import type { ThemeConfig } from "@/themes";

const h = vi.hoisted(() => ({
  theme: "custom" as string,
  customTheme: undefined as ThemeConfig | undefined,
  userThemes: [] as unknown[],
  user: { pubkey: "a".repeat(64) } as { pubkey: string } | undefined,
  applyCustomTheme: vi.fn(),
  creator: vi.fn(),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    theme: h.theme,
    customTheme: h.customTheme,
    setTheme: vi.fn(),
    applyCustomTheme: h.applyCustomTheme,
  }),
}));
vi.mock("@/hooks/useUserThemes", () => ({
  useUserThemes: () => ({ data: h.userThemes, isLoading: false }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaSrc: () => undefined }));
vi.mock("@/components/discover/ThemeCreatorDialog", () => ({
  ThemeCreatorDialog: (props: { editing?: unknown; initial?: unknown }) => {
    h.creator(props);
    return <div>creator</div>;
  },
}));
vi.mock("@/components/ThemeBackgroundField", () => ({ ThemeBackgroundField: () => null }));
// The color picker paints on a canvas, which jsdom does not implement.
vi.mock("@/components/ui/color-picker", () => ({
  ColorPicker: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}));

const SUNSET: ThemeConfig = {
  title: "Sunset",
  colors: { background: "20 40% 10%", text: "30 30% 90%", primary: "15 85% 55%" },
  font: { family: "Lora" },
};

describe("ThemeSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.theme = "custom";
    h.customTheme = SUNSET;
    h.userThemes = [];
    h.user = { pubkey: "a".repeat(64) };
  });

  it("opens the library creator from New theme", () => {
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: /New theme/ }));
    expect(h.creator).toHaveBeenCalledWith(expect.objectContaining({ editing: undefined, initial: undefined }));
  });

  it("offers to save a theme in use that isn't in the library", () => {
    render(<ThemeSelector />);
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save to my themes" }));
    expect(h.creator).toHaveBeenCalledWith(expect.objectContaining({ initial: SUNSET }));
  });

  it("marks a library theme active and applies it with its font", () => {
    h.userThemes = [{ identifier: "sunset-x1", ...SUNSET, title: "Sunset", event: {} }];
    render(<ThemeSelector />);
    expect(screen.queryByText("Not saved")).toBeNull();
    const tile = screen.getAllByRole("button", { name: /Sunset/ }).find((b) => b.hasAttribute("aria-pressed"))!;
    expect(tile).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(tile);
    expect(h.applyCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ font: { family: "Lora" } }));
  });

  it("builds on this device when signed out", () => {
    h.user = undefined;
    h.customTheme = undefined;
    h.theme = "dark";
    render(<ThemeSelector />);
    fireEvent.click(screen.getByRole("button", { name: /New theme/ }));
    expect(h.creator).not.toHaveBeenCalled();
    expect(screen.getByText(/Kept on this device/)).toBeInTheDocument();
  });
});

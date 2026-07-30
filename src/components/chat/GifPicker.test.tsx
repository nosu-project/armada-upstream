import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GifPicker } from "@/components/chat/GifPicker";

vi.mock("@/hooks/useGifSearch", () => ({
  registerGifShare: vi.fn(),
  useGifSearch: () => ({
    query: "",
    setQuery: vi.fn(),
    clearQuery: vi.fn(),
    results: [],
    isLoading: false,
    isError: false,
    isSearching: false,
    providerName: "KLIPY",
  }),
}));

vi.mock("@/hooks/useFavoriteGifs", () => ({
  useFavoriteGifs: () => ({
    isFavorite: vi.fn(() => false),
    toggleFavorite: vi.fn(),
    favoriteList: vi.fn(() => []),
    count: 0,
  }),
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

describe("GifPicker", () => {
  it("uses KLIPY's required search attribution", () => {
    render(<GifPicker onSelect={vi.fn()} />);

    expect(screen.getByPlaceholderText("Search KLIPY")).toBeInTheDocument();
    expect(screen.getByText("Powered by KLIPY")).toBeInTheDocument();
  });
});

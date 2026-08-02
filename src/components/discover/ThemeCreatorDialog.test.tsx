import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeCreatorDialog } from "./ThemeCreatorDialog";
import { THEME_DEFINITION_KIND } from "@/lib/themeEvent";

import type { NostrRumor } from "@/lib/nostrRumor";

const h = vi.hoisted(() => ({
  publishEvent: vi.fn(),
  applyCustomTheme: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publishEvent, isPending: false }),
}));
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ applyCustomTheme: h.applyCustomTheme }),
}));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
// The color picker paints on a canvas, which jsdom does not implement. Its own
// behaviour is not what this dialog is responsible for.
vi.mock("@/components/ui/color-picker", () => ({
  ColorPicker: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}));

const PUBLISHED = { id: "new-theme-event", kind: THEME_DEFINITION_KIND } as NostrRumor;

/** The unsearched Discover themes key: [.., relays, authorFilter, query]. */
const BROWSE_KEY = ["discover", "themes", ["wss://relay.example"], "all", ""];
/** The same tab with a search term — deliberately left alone. */
const SEARCH_KEY = ["discover", "themes", ["wss://relay.example"], "all", "sunset"];

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const existing = [{ id: "existing-theme" } as NostrRumor];
  queryClient.setQueryData(BROWSE_KEY, existing);
  queryClient.setQueryData(SEARCH_KEY, existing);

  render(
    <QueryClientProvider client={queryClient}>
      <ThemeCreatorDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
  return queryClient;
}

const publishButton = () => screen.getByRole("button", { name: "Publish theme" });
const nameField = () => screen.getByLabelText("Name");

describe("ThemeCreatorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.publishEvent.mockResolvedValue(PUBLISHED);
  });

  it("will not publish an unnamed theme", () => {
    renderDialog();

    expect(publishButton()).toBeDisabled();
    expect(screen.getByText("Give the theme a name.")).toBeInTheDocument();

    fireEvent.change(nameField(), { target: { value: "Sunset" } });

    expect(publishButton()).toBeEnabled();
    expect(
      screen.getByText("Anyone will be able to find and apply this theme."),
    ).toBeInTheDocument();
  });

  it("publishes a kind 36767 definition carrying the trimmed name", async () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: "  Sunset  " } });
    fireEvent.click(publishButton());

    await waitFor(() => expect(h.publishEvent).toHaveBeenCalledTimes(1));
    const template = h.publishEvent.mock.calls[0][0];
    expect(template.kind).toBe(THEME_DEFINITION_KIND);
    expect(template.tags).toContainEqual(["title", "Sunset"]);
    expect(template.tags.filter(([n]: string[]) => n === "c")).toHaveLength(3);
    // The active profile theme (kind 16767) is a separate action, never this one.
    expect(h.publishEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 16767 }));
  });

  it("seeds the browse grid with the new theme instead of refetching it away", async () => {
    const queryClient = renderDialog();
    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() => {
      expect(queryClient.getQueryData<NostrRumor[]>(BROWSE_KEY)).toEqual([
        PUBLISHED,
        { id: "existing-theme" },
      ]);
    });
    // Marked stale so the next natural fetch reconciles, but not refetched now:
    // a refetch races relay indexing and can return less than is on screen.
    expect(queryClient.getQueryState(BROWSE_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(BROWSE_KEY)?.fetchStatus).toBe("idle");
    // A search result has its own criteria — the new theme may not match it.
    expect(queryClient.getQueryData<NostrRumor[]>(SEARCH_KEY)).toEqual([{ id: "existing-theme" }]);
  });

  it("refreshes the settings theme library", async () => {
    const queryClient = renderDialog();
    queryClient.setQueryData(["user-themes", "pubkey"], []);
    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() => {
      expect(queryClient.getQueryState(["user-themes", "pubkey"])?.isInvalidated).toBe(true);
    });
  });

  it("applies the theme locally when the box is checked, and not when it is cleared", async () => {
    renderDialog();
    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(h.applyCustomTheme).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Sunset" }),
      ),
    );

    vi.clearAllMocks();
    h.publishEvent.mockResolvedValue(PUBLISHED);
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply as my theme" }));
    fireEvent.click(publishButton());

    await waitFor(() => expect(h.publishEvent).toHaveBeenCalled());
    expect(h.applyCustomTheme).not.toHaveBeenCalled();
  });

  it("leaves the dialog open and applies nothing when publishing fails", async () => {
    const onOpenChange = vi.fn();
    h.publishEvent.mockRejectedValue(new Error("no relay accepted the event"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(BROWSE_KEY, [{ id: "existing-theme" } as NostrRumor]);
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeCreatorDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );

    fireEvent.change(nameField(), { target: { value: "Sunset" } });
    fireEvent.click(publishButton());

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't publish theme", variant: "destructive" }),
      ),
    );
    expect(h.applyCustomTheme).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<NostrRumor[]>(BROWSE_KEY)).toEqual([{ id: "existing-theme" }]);
  });
});

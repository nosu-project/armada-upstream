import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeDiscoverCard } from "./ThemeDiscoverCard";
import { buildThemeDefinitionEvent, THEME_DEFINITION_KIND } from "@/lib/themeEvent";

import type { NostrRumor } from "@/lib/nostrRumor";

const ME = "a".repeat(64);
const CREATOR = "c".repeat(64);
const KEEPER = "b".repeat(64);

const h = vi.hoisted(() => ({ publishEvent: vi.fn(), toast: vi.fn() }));

vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: h.publishEvent, isPending: false }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: ME } }) }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => ({ theme: "dark", customTheme: undefined }) }));
vi.mock("@/hooks/useUserThemes", () => ({ useUserThemes: () => ({ data: [] }) }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AvatarImage: () => null,
  AvatarFallback: () => null,
}));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaSrc: () => undefined }));
vi.mock("@/hooks/useNaddrLink", () => ({ useNaddrLink: () => ({ naddr: undefined, copied: false, copy: vi.fn() }) }));
vi.mock("@/hooks/useToast", () => ({ toast: h.toast }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <>{name}</> }));

const COLORS = { background: "275 31% 6%", text: "0 0% 100%", primary: "24 100% 50%" };

function rumor(pubkey: string, template: ReturnType<typeof buildThemeDefinitionEvent>): NostrRumor {
  return { ...template, id: `${pubkey}-event`, pubkey, created_at: 1 } as NostrRumor;
}

function renderCard(event: NostrRumor) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThemeDiscoverCard event={event} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function savedTags(): Promise<string[][]> {
  fireEvent.click(screen.getByRole("button", { name: "Save to my themes" }));
  await waitFor(() => expect(h.publishEvent).toHaveBeenCalledTimes(1));
  return h.publishEvent.mock.calls[0][0].tags;
}

describe("ThemeDiscoverCard save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.publishEvent.mockImplementation(async (t) => ({ ...t, id: "saved", pubkey: ME, created_at: 2, sig: "" }));
  });

  it("credits the theme's author on the saved copy", async () => {
    renderCard(rumor(CREATOR, buildThemeDefinitionEvent("Dusk", COLORS, "dusk", { font: { family: "Lora" } })));
    const tags = await savedTags();
    expect(tags).toContainEqual(["a", `${THEME_DEFINITION_KIND}:${CREATOR}:dusk`]);
    expect(tags).toContainEqual(["p", CREATOR]);
    expect(tags.find(([n]) => n === "f")?.[1]).toBe("Lora");
  });

  it("credits the original creator, not whoever kept the copy it was saved from", async () => {
    renderCard(rumor(KEEPER, buildThemeDefinitionEvent("Dusk", COLORS, "dusk-copy", {
      source: { pubkey: CREATOR, identifier: "dusk" },
    })));
    const tags = await savedTags();
    expect(tags).toContainEqual(["a", `${THEME_DEFINITION_KIND}:${CREATOR}:dusk`]);
    expect(tags).toContainEqual(["p", CREATOR]);
    expect(tags).not.toContainEqual(["p", KEEPER]);
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CharacterCardEmbed } from "@/components/chat/CharacterCard";
import { AppContext, type AppContextType } from "@/contexts/AppContext";
import { parseCharacterCardJson, type CharaCard } from "@/lib/characterCard";

import type { ReactNode } from "react";

// See Lightbox.test.tsx: the media hooks read mirror/proxy config off the app
// context object; no mirrors and no proxy keeps every URL as-is.
const context = {
  config: {
    blossomServerMetadata: { servers: [] },
    mediaProxies: [],
  },
  updateConfig: vi.fn(),
} as unknown as AppContextType;
const wrap = (children: ReactNode) => <AppContext.Provider value={context}>{children}</AppContext.Provider>;

const FIXTURE_CARD = parseCharacterCardJson({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Testchar",
    description: "A description of Testchar.",
    first_mes: "*{{char}} waves at you.*",
    tags: ["testing"],
    creator: "suite",
    character_version: "1.2",
    character_book: {
      name: "Testchar-WI",
      entries: [
        { keys: ["lore"], content: "Some lore about the world.", comment: "Lore notes" },
        { keys: ["off"], content: "An entry turned off.", enabled: false },
      ],
    },
  },
}) as CharaCard;
if (!FIXTURE_CARD) throw new Error("fixture card did not parse");

function renderEmbed() {
  return render(wrap(
    <CharacterCardEmbed card={FIXTURE_CARD} image={{ url: "https://example.com/testchar.png", mime: "image/png" }} />,
  ));
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "View character card: Testchar" }));
}

/** Radix layers + the lightbox all take `role="dialog"`; the lightbox is the z-[300] one. */
function dialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[role=\"dialog\"]"));
}

describe("CharacterCardEmbed", () => {
  it("shows the card name and label in the chat preview", () => {
    renderEmbed();
    const preview = screen.getByRole("button", { name: "View character card: Testchar" });
    expect(preview.textContent).toContain("Testchar");
    expect(preview.textContent).toContain("Character card · by suite");
  });

  it("keeps the card's capitalization in the dialog title", () => {
    renderEmbed();
    openDialog();
    const title = document.querySelector(".chrome-dialog-title");
    expect(title?.textContent).toBe("Testchar");
    // The chrome heading is styled lowercase; the card name opts out of it.
    expect(title?.querySelector("span.normal-case")?.textContent).toBe("Testchar");
  });

  it("shows the character book with entry labels and disabled markers", () => {
    renderEmbed();
    openDialog();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Character book · 2 entries");
    expect(body).toContain("Lore notes");
    expect(body).toContain("Some lore about the world.");
    expect(body).toContain("off(disabled)");
    // {{char}} is filled in for display, and `*action*` renders as emphasis.
    expect(document.querySelector("em")?.textContent).toBe("Testchar waves at you.");
  });

  it("opens the artwork lightbox ABOVE the dialog with live controls", () => {
    renderEmbed();
    openDialog();
    expect(document.body.style.pointerEvents).toBe("none");
    expect(dialogs()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "View artwork full size" }));
    const layers = dialogs();
    expect(layers).toHaveLength(2);
    // Above the z-250 dialog, and re-enabled against the modal dialog's
    // `pointer-events: none` on body, or its buttons silently absorb nothing.
    const lightbox = layers.find((el) => el.classList.contains("z-[300]"));
    expect(lightbox).toBeDefined();
    expect(lightbox!.classList.contains("pointer-events-auto")).toBe(true);

    // Esc closes the lightbox but not the dialog underneath.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(dialogs()).toHaveLength(1);
    expect(document.body.textContent).toContain("Character book · 2 entries");
  });

  it("hides comments, renders fences and <START> separators, and copies the raw field", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const raw = "<!--hidden world event-->Hello {{user}}.\n```\nMana: 100\n```";
    const example = "<START>\n{{user}}: hi\n{{char}}: hey\n<START>\n{{user}}: again";
    const card = { ...FIXTURE_CARD, first_mes: raw, mes_example: example };
    render(wrap(<CharacterCardEmbed card={card} image={{ url: "https://example.com/c.png", mime: "image/png" }} />));
    openDialog();
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("hidden world event");
    expect(body).not.toContain("<START>");
    expect(body).not.toContain("```");
    expect(body).not.toContain("{{");
    expect(document.querySelector("pre")?.textContent).toContain("Mana: 100");
    expect(body).toContain("Testchar: hey");

    fireEvent.click(screen.getByRole("button", { name: "Copy first message" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(raw));
  });

  it("closing the lightbox by its own close control also keeps the dialog", () => {
    renderEmbed();
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "View artwork full size" }));
    const lightbox = dialogs().find((el) => el.classList.contains("z-[300]"));
    expect(lightbox).toBeDefined();
    fireEvent.click(within(lightbox!).getByRole("button", { name: "Close" }));
    expect(dialogs()).toHaveLength(1);
    expect(document.body.textContent).toContain("Character book · 2 entries");
  });
});

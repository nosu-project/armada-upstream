import { describe, expect, it } from "vitest";

import {
  ACTIVE_THEME_KIND,
  THEME_DEFINITION_KIND,
  buildThemeDefinitionEvent,
  parseDittoTheme,
} from "@/lib/themeEvent";
import { hslStringToHex } from "@/lib/colorUtils";

import type { CoreThemeColors } from "@/themes";
import type { NostrRumor } from "@/lib/nostrRumor";

const COLORS: CoreThemeColors = {
  background: "222 18% 9%",
  text: "220 14% 92%",
  primary: "235 80% 68%",
};

/** Wrap an event template in the rumor shape `parseDittoTheme` consumes. */
function asRumor(template: { kind: number; content: string; tags: string[][] }): NostrRumor {
  return {
    id: "test-id",
    pubkey: "test-pubkey",
    created_at: 0,
    ...template,
  } as NostrRumor;
}

describe("buildThemeDefinitionEvent → parseDittoTheme round trip", () => {
  it("preserves the title and all three core colors", () => {
    const built = buildThemeDefinitionEvent("Midnight Galaxy", COLORS, "midnight-galaxy");
    const parsed = parseDittoTheme(asRumor(built));

    expect(parsed).not.toBeNull();
    expect(parsed!.identifier).toBe("midnight-galaxy");
    expect(parsed!.title).toBe("Midnight Galaxy");
    // HSL → hex → HSL is lossy (hex quantises to 8 bits per channel, and hue
    // drifts on dark low-saturation colors), so compare in hex — the form the
    // colors actually travel in. That identity is the guarantee we need.
    for (const key of ["background", "text", "primary"] as const) {
      expect(hslStringToHex(parsed!.colors[key])).toBe(hslStringToHex(COLORS[key]));
    }
  });

  it("emits the Ditto-compatible tag set", () => {
    const built = buildThemeDefinitionEvent("Midnight Galaxy", COLORS, "midnight-galaxy");

    expect(built.kind).toBe(THEME_DEFINITION_KIND);
    expect(built.content).toBe("");
    expect(built.tags).toContainEqual(["alt", "Custom theme: Midnight Galaxy"]);
    expect(built.tags).toContainEqual(["t", "theme"]);

    const colorTags = built.tags.filter(([n]) => n === "c");
    expect(colorTags).toHaveLength(3);
    expect(colorTags.map((t) => t[2]).sort()).toEqual(["background", "primary", "text"]);
    // Colors go on the wire as hex, not as HSL strings.
    for (const tag of colorTags) expect(tag[1]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("generates a slug when no identifier is supplied", () => {
    const built = buildThemeDefinitionEvent("  Midnight Galaxy!  ", COLORS);
    const d = built.tags.find(([n]) => n === "d")![1];

    expect(d).toMatch(/^midnight-galaxy-[a-z0-9]+$/);
    // The title keeps its own trimming, independent of the slug.
    expect(built.tags.find(([n]) => n === "title")![1]).toBe("Midnight Galaxy!");
  });

  it("falls back to a default name for a blank title", () => {
    const built = buildThemeDefinitionEvent("   ", COLORS);

    expect(built.tags.find(([n]) => n === "title")![1]).toBe("My theme");
    expect(built.tags).toContainEqual(["alt", "Custom theme: My theme"]);
  });
});

describe("parseDittoTheme", () => {
  it("rejects an event missing a color role", () => {
    const built = buildThemeDefinitionEvent("Half a theme", COLORS, "half");
    built.tags = built.tags.filter((tag) => !(tag[0] === "c" && tag[2] === "primary"));

    expect(parseDittoTheme(asRumor(built))).toBeNull();
  });

  it("rejects an event with a malformed hex color", () => {
    const built = buildThemeDefinitionEvent("Bad hex", COLORS, "bad-hex");
    const primary = built.tags.find((tag) => tag[0] === "c" && tag[2] === "primary")!;
    primary[1] = "not-a-color";

    expect(parseDittoTheme(asRumor(built))).toBeNull();
  });

  it("rejects a kind it does not own", () => {
    const built = buildThemeDefinitionEvent("Wrong kind", COLORS, "wrong-kind");

    expect(parseDittoTheme(asRumor({ ...built, kind: 1 }))).toBeNull();
  });

  it("reads a kind 16767 active profile theme, which carries no d tag", () => {
    const built = buildThemeDefinitionEvent("Active", COLORS, "active");
    const active = {
      ...built,
      kind: ACTIVE_THEME_KIND,
      tags: built.tags.filter(([n]) => n !== "d"),
    };

    const parsed = parseDittoTheme(asRumor(active));
    expect(parsed).not.toBeNull();
    expect(parsed!.identifier).toBe("");
    expect(parsed!.title).toBe("Active");
  });

  it("ignores the legacy JSON-in-content format, whose colors are unvalidated", () => {
    const hex = asRumor({
      kind: THEME_DEFINITION_KIND,
      content: JSON.stringify({ background: "#14141e", foreground: "#e8eaf6", primary: "#7c4dff" }),
      tags: [["d", "legacy"], ["title", "Legacy"]],
    });
    expect(parseDittoTheme(hex)).toBeNull();

    const breakout = asRumor({
      kind: THEME_DEFINITION_KIND,
      content: JSON.stringify({
        background: "0 0% 0%;} body{background:url(https://evil.example/x)} :root{--a:1",
        text: "0 0% 100%",
        primary: "0 0% 50%",
      }),
      tags: [["d", "evil"]],
    });
    expect(parseDittoTheme(breakout)).toBeNull();
  });

  it("falls back to the d tag when there is no title", () => {
    const built = buildThemeDefinitionEvent("Titled", COLORS, "the-slug");
    built.tags = built.tags.filter(([n]) => n !== "title");

    expect(parseDittoTheme(asRumor(built))!.title).toBe("the-slug");
  });
});

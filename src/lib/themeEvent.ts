import { hexToHslString, hslStringToHex, isValidHex } from "@/lib/colorUtils";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { CoreThemeColors } from "@/themes";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Ditto theme events (interop). Ditto publishes a user's theme library and
 * active profile theme as public Nostr events. Armada reads them so themes
 * created in Ditto show up here. We only consume the 3 core colors; Ditto's
 * optional fonts/backgrounds are ignored.
 *
 * See ditto/src/lib/themeEvent.ts.
 */

/** Addressable: a named theme definition. Multiple per user (the library). */
export const THEME_DEFINITION_KIND = 36767;
/** Replaceable: the user's currently active profile theme. One per user. */
export const ACTIVE_THEME_KIND = 16767;

/** Parse the `c` color tags (hex, role-tagged) into CoreThemeColors. */
function parseColorTags(tags: string[][]): CoreThemeColors | null {
  const map = new Map<string, string>();
  for (const tag of tags) {
    if (tag[0] === "c" && tag[1] && tag[2]) map.set(tag[2], tag[1]);
  }
  const bg = map.get("background");
  const text = map.get("text");
  const primary = map.get("primary");
  if (!bg || !text || !primary) return null;
  if (!isValidHex(bg) || !isValidHex(text) || !isValidHex(primary)) return null;
  return {
    background: hexToHslString(bg),
    text: hexToHslString(text),
    primary: hexToHslString(primary),
  };
}

/** A named Ditto theme reduced to what Armada uses. */
export interface DittoTheme {
  /** d-tag identifier (definitions only). */
  identifier: string;
  title: string;
  colors: CoreThemeColors;
}

/** Parse a kind 36767 / 16767 event into a DittoTheme. Returns null if invalid. */
export function parseDittoTheme(event: NostrRumor): DittoTheme | null {
  if (event.kind !== THEME_DEFINITION_KIND && event.kind !== ACTIVE_THEME_KIND) return null;

  // New format: colors in `c` tags. Legacy: JSON (4-color or 19-token) in content.
  let colors = parseColorTags(event.tags);
  if (!colors && event.content) {
    try {
      const parsed = JSON.parse(event.content) as Record<string, string>;
      const bg = parsed.background;
      const text = parsed.text ?? parsed.foreground;
      const primary = parsed.primary;
      if (bg && text && primary) {
        const toHsl = (v: string) => (isValidHex(v) ? hexToHslString(v) : v);
        colors = { background: toHsl(bg), text: toHsl(text), primary: toHsl(primary) };
      }
    } catch {
      // ignore invalid content
    }
  }
  if (!colors) return null;

  const identifier = event.tags.find(([n]) => n === "d")?.[1] ?? "";
  const title =
    event.tags.find(([n]) => n === "title")?.[1] || identifier || "Untitled theme";

  return { identifier, title, colors };
}

/** A short, stable-ish slug for a theme's `d` identifier. */
function slugify(title: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "theme";
}

/**
 * Build a kind-36767 theme definition event (Ditto-compatible) publishing the 3
 * core colors as role-tagged `c` hex tags. Used by the "Share to Discover"
 * action so an Armada-authored theme shows up in the theme directory (and in
 * Ditto). Only ever published on an explicit user action.
 */
export function buildThemeDefinitionEvent(
  title: string,
  colors: CoreThemeColors,
  identifier?: string,
): EventTemplate {
  const name = title.trim() || "My theme";
  const d = identifier?.trim() || `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    kind: THEME_DEFINITION_KIND,
    content: "",
    tags: [
      ["d", d],
      ["title", name],
      ["c", hslStringToHex(colors.background), "background"],
      ["c", hslStringToHex(colors.text), "text"],
      ["c", hslStringToHex(colors.primary), "primary"],
      // NIP-31 fallback text and the topic tag, matching what Ditto emits
      // (ditto/src/lib/themeEvent.ts buildThemeDefinitionTags). Neither Ditto's
      // theme feed nor Armada's Discover filters on `t` — it is for clients and
      // relays that index by topic.
      ["alt", `Custom theme: ${name}`],
      ["t", "theme"],
    ],
  };
}

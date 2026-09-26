import { hexToHslString, hslStringToHex, isValidHex } from "@/lib/colorUtils";
import { sanitizeUrl } from "@/lib/sanitizeUrl";

import type { EventTemplate } from "@/hooks/useNostrPublish";
import type { CoreThemeColors } from "@/themes";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Ditto theme events (interop). Ditto publishes a user's theme library and
 * active profile theme as public Nostr events. Armada reads them so themes
 * created in Ditto show up here, and the profile view renders the full theme:
 * the 3 core colors plus the optional body/title fonts and background image.
 *
 * See ditto/src/lib/themeEvent.ts.
 */

/** Addressable: a named theme definition. Multiple per user (the library). */
export const THEME_DEFINITION_KIND = 36767;
/** Replaceable: the user's currently active profile theme. One per user. */
export const ACTIVE_THEME_KIND = 16767;

/** A theme font: a CSS family name plus an optional remote .woff2/.css URL. */
export interface ThemeFont {
  family: string;
  url?: string;
}

/** A theme background image (`bg` tag, imeta-style key-value entries). */
export interface ThemeBackground {
  url: string;
  /** How the image fills the page. Default: cover. */
  mode?: "cover" | "tile";
  mimeType?: string;
  /** `<width>x<height>` as published. */
  dimensions?: string;
  blurhash?: string;
}

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

/** Build `c` tags from CoreThemeColors (HSL → hex). */
function buildColorTags(colors: CoreThemeColors): string[][] {
  return (["background", "text", "primary"] as const).map((role) => [
    "c",
    hslStringToHex(colors[role]),
    role,
  ]);
}

/**
 * Parse `f` tags into body and title fonts. Tag shape:
 * `["f", family, url, "body"|"title"]`; a tag without a role (legacy) is body.
 */
function parseFontTags(tags: string[][]): { font?: ThemeFont; titleFont?: ThemeFont } {
  let font: ThemeFont | undefined;
  let titleFont: ThemeFont | undefined;
  for (const tag of tags) {
    if (tag[0] !== "f" || !tag[1]) continue;
    const parsed: ThemeFont = { family: tag[1] };
    const url = sanitizeUrl(tag[2]);
    if (url) parsed.url = url;
    if (tag[3] === "title") {
      if (!titleFont) titleFont = parsed;
    } else if (!font) {
      font = parsed;
    }
  }
  return { font, titleFont };
}

/** Build `f` tags. Body before title, matching Ditto's emit order. */
function buildFontTags(font: ThemeFont | undefined, titleFont: ThemeFont | undefined): string[][] {
  const tags: string[][] = [];
  if (font?.family) tags.push(["f", font.family, font.url ?? "", "body"]);
  if (titleFont?.family) tags.push(["f", titleFont.family, titleFont.url ?? "", "title"]);
  return tags;
}

/** Parse the `bg` tag (imeta-style `key value` entries) into ThemeBackground. */
function parseBackgroundTag(tags: string[][]): ThemeBackground | undefined {
  const bgTag = tags.find(([n]) => n === "bg");
  if (!bgTag) return undefined;
  const kv = new Map<string, string>();
  for (let i = 1; i < bgTag.length; i++) {
    const entry = bgTag[i];
    const spaceIdx = entry.indexOf(" ");
    if (spaceIdx === -1) continue;
    kv.set(entry.slice(0, spaceIdx), entry.slice(spaceIdx + 1));
  }
  const url = sanitizeUrl(kv.get("url"));
  if (!url) return undefined;
  const bg: ThemeBackground = { url };
  const mode = kv.get("mode");
  if (mode === "cover" || mode === "tile") bg.mode = mode;
  bg.mimeType = kv.get("m");
  bg.dimensions = kv.get("dim");
  bg.blurhash = kv.get("blurhash");
  return bg;
}

/** Build the `bg` tag from ThemeBackground. Empty when there is no image. */
function buildBackgroundTag(bg: ThemeBackground | undefined): string[][] {
  if (!bg?.url) return [];
  const entries: string[] = ["bg", `url ${bg.url}`];
  if (bg.mode) entries.push(`mode ${bg.mode}`);
  if (bg.mimeType) entries.push(`m ${bg.mimeType}`);
  if (bg.dimensions) entries.push(`dim ${bg.dimensions}`);
  if (bg.blurhash) entries.push(`blurhash ${bg.blurhash}`);
  return [entries];
}

/** A named Ditto theme reduced to what Armada uses. */
export interface DittoTheme {
  /** d-tag identifier (definitions only). */
  identifier: string;
  title: string;
  colors: CoreThemeColors;
  /** Optional body font. */
  font?: ThemeFont;
  /** Optional title/display-name font. Falls back to `font` when absent. */
  titleFont?: ThemeFont;
  /** Optional page background image. */
  background?: ThemeBackground;
  description?: string;
  /** `a`-tag coordinate of the source kind-36767 definition (16767 only). */
  sourceRef?: string;
}

/** Parse a kind 36767 / 16767 event into a DittoTheme. Returns null if invalid. */
export function parseDittoTheme(event: NostrRumor): DittoTheme | null {
  if (event.kind !== THEME_DEFINITION_KIND && event.kind !== ACTIVE_THEME_KIND) return null;

  // Colors come only from the hex-validated `c` tags. The legacy
  // JSON-in-content format is not read: its values reached the injected
  // theme <style> unchecked (Ditto dropped it in bd1a3bdb for the same
  // reason), and a genuine old theme renders again once its owner re-saves.
  const colors = parseColorTags(event.tags);
  if (!colors) return null;

  const identifier = event.tags.find(([n]) => n === "d")?.[1] ?? "";
  const title =
    event.tags.find(([n]) => n === "title")?.[1] || identifier || "Untitled theme";
  const description = event.tags.find(([n]) => n === "description")?.[1];
  const { font, titleFont } = parseFontTags(event.tags);
  const background = parseBackgroundTag(event.tags);
  const sourceRef =
    event.kind === ACTIVE_THEME_KIND ? event.tags.find(([n]) => n === "a")?.[1] : undefined;

  return { identifier, title, colors, font, titleFont, background, description, sourceRef };
}

/** The optional non-color parts of a theme, shared by both builders. */
export interface ThemeExtras {
  font?: ThemeFont;
  titleFont?: ThemeFont;
  background?: ThemeBackground;
  description?: string;
}

/** A short, stable-ish slug for a theme's `d` identifier. */
function slugify(title: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "theme";
}

/**
 * Build a kind-36767 theme definition event (Ditto-compatible) publishing the 3
 * core colors as role-tagged `c` hex tags, plus any fonts/background. Used by
 * the "Share to Discover" action so an Armada-authored theme shows up in the
 * theme directory (and in Ditto). Only ever published on an explicit user
 * action.
 */
export function buildThemeDefinitionEvent(
  title: string,
  colors: CoreThemeColors,
  identifier?: string,
  extras?: ThemeExtras,
): EventTemplate {
  const name = title.trim() || "My theme";
  const d = identifier?.trim() || `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
  const tags: string[][] = [
    ["d", d],
    ["title", name],
    ...buildColorTags(colors),
    ...buildFontTags(extras?.font, extras?.titleFont),
    ...buildBackgroundTag(extras?.background),
    // NIP-31 fallback text and the topic tag, matching what Ditto emits
    // (ditto/src/lib/themeEvent.ts buildThemeDefinitionTags). Neither Ditto's
    // theme feed nor Armada's Discover filters on `t` — it is for clients and
    // relays that index by topic.
    ["alt", `Custom theme: ${name}`],
    ["t", "theme"],
  ];
  if (extras?.description) tags.push(["description", extras.description]);
  return { kind: THEME_DEFINITION_KIND, content: "", tags };
}

/**
 * Build the kind-16767 active profile theme event (Ditto-compatible). One per
 * user, replaceable; publishing it is what makes a profile wear a theme.
 * `sourceRef` is the `a` coordinate of the kind-36767 definition it was
 * applied from, when there is one. Only ever published on an explicit user
 * action (the profile theme editor's Save / Remove).
 */
export function buildActiveThemeEvent(
  colors: CoreThemeColors,
  opts?: ThemeExtras & { title?: string; sourceRef?: string },
): EventTemplate {
  const tags: string[][] = [
    ...buildColorTags(colors),
    ...buildFontTags(opts?.font, opts?.titleFont),
    ...buildBackgroundTag(opts?.background),
    ["alt", "Active profile theme"],
  ];
  if (opts?.title) tags.push(["title", opts.title]);
  if (opts?.description) tags.push(["description", opts.description]);
  if (opts?.sourceRef) tags.push(["a", opts.sourceRef]);
  return { kind: ACTIVE_THEME_KIND, content: "", tags };
}

/**
 * Build the kind-16767 that REMOVES the profile theme: an empty replacement,
 * matching Ditto's clearActiveTheme (an event with colors is "has a theme";
 * one without parses to null everywhere).
 */
export function buildClearActiveThemeEvent(): EventTemplate {
  return { kind: ACTIVE_THEME_KIND, content: "", tags: [] };
}

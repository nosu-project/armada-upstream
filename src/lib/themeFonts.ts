/**
 * The curated theme font catalog — the same families Ditto bundles
 * (ditto/src/lib/fonts.ts), as DATA rather than @fontsource packages: Armada
 * loads every theme font by URL (see fontLoader.ts), so all it needs per
 * family is the fontsource CDN .woff2 the published `f` tag should carry.
 * Keeping the list identical means a theme authored in either client names a
 * family the other can render.
 */

export type ThemeFontCategory = "sans" | "serif" | "mono" | "display" | "handwriting";

export interface ThemeFontOption {
  /** Canonical font-family name used in Nostr events and UI display. */
  family: string;
  /** Fontsource CDN URL for the .woff2 (published in the `f` tag). */
  cdnUrl: string;
  /** Category for UI grouping. */
  category: ThemeFontCategory;
}

const cdn = (pkg: string, variable: boolean) =>
  variable
    ? `https://cdn.jsdelivr.net/fontsource/fonts/${pkg}:vf@latest/latin-wght-normal.woff2`
    : `https://cdn.jsdelivr.net/fontsource/fonts/${pkg}@latest/latin-400-normal.woff2`;

export const themeFontOptions: ThemeFontOption[] = [
  { family: "Inter", cdnUrl: cdn("inter", true), category: "sans" },
  { family: "DM Sans", cdnUrl: cdn("dm-sans", true), category: "sans" },
  { family: "Outfit", cdnUrl: cdn("outfit", true), category: "sans" },
  { family: "Montserrat", cdnUrl: cdn("montserrat", true), category: "sans" },
  { family: "Nunito", cdnUrl: cdn("nunito", true), category: "sans" },
  { family: "Lora", cdnUrl: cdn("lora", true), category: "serif" },
  { family: "Merriweather", cdnUrl: cdn("merriweather", true), category: "serif" },
  { family: "Playfair Display", cdnUrl: cdn("playfair-display", true), category: "serif" },
  { family: "JetBrains Mono", cdnUrl: cdn("jetbrains-mono", true), category: "mono" },
  { family: "Courier Prime", cdnUrl: cdn("courier-prime", false), category: "mono" },
  { family: "Comfortaa", cdnUrl: cdn("comfortaa", true), category: "display" },
  { family: "Fredoka", cdnUrl: cdn("fredoka", true), category: "display" },
  { family: "Permanent Marker", cdnUrl: cdn("permanent-marker", false), category: "display" },
  { family: "Cherry Bomb One", cdnUrl: cdn("cherry-bomb-one", false), category: "display" },
  { family: "Creepster", cdnUrl: cdn("creepster", false), category: "display" },
  { family: "Silkscreen", cdnUrl: cdn("silkscreen", false), category: "display" },
  { family: "Bungee Shade", cdnUrl: cdn("bungee-shade", false), category: "display" },
  { family: "Luckiest Guy", cdnUrl: cdn("luckiest-guy", false), category: "display" },
  { family: "Press Start 2P", cdnUrl: cdn("press-start-2p", false), category: "display" },
  { family: "Pirata One", cdnUrl: cdn("pirata-one", false), category: "display" },
  { family: "Special Elite", cdnUrl: cdn("special-elite", false), category: "display" },
  { family: "Comic Relief", cdnUrl: cdn("comic-relief", false), category: "handwriting" },
  { family: "Caveat", cdnUrl: cdn("caveat", false), category: "handwriting" },
  { family: "Pacifico", cdnUrl: cdn("pacifico", false), category: "handwriting" },
  { family: "Comic Neue", cdnUrl: cdn("comic-neue", false), category: "handwriting" },
];

const byFamily = new Map(themeFontOptions.map((f) => [f.family.toLowerCase(), f]));

/** Find a catalog font by family name (case-insensitive). */
export function findThemeFont(family: string): ThemeFontOption | undefined {
  return byFamily.get(family.toLowerCase());
}

/**
 * Resolve the URL a published `f` tag should carry for a family: catalog
 * fonts get the CDN URL (so other clients can load them without the catalog),
 * anything else keeps whatever URL it already had.
 */
export function resolveThemeFontUrl(family: string, existingUrl?: string): string | undefined {
  return findThemeFont(family)?.cdnUrl ?? existingUrl;
}

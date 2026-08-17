/**
 * Theme font loading.
 *
 * Every theme font is loaded by URL — a `@font-face` rule injected into the
 * document head (idempotent per URL). Families from the catalog
 * (themeFonts.ts) fall back to their fontsource CDN URL when the event's `f`
 * tag carries none. Unlike Ditto there is no global font override: Armada
 * applies theme fonts SCOPED, as inline `font-family` / `--title-font-family`
 * on the themed container (the profile page), so nothing has to be restored
 * on unmount.
 */

import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { findThemeFont } from "@/lib/themeFonts";

import type { ThemeFont } from "@/lib/themeEvent";

/**
 * Sanitize a string for safe interpolation into a double-quoted CSS context.
 * Allowlist: Unicode letters, numbers, spaces, hyphens, underscores,
 * apostrophes, periods. Use whenever event-sourced strings flow into a CSS
 * declaration value (e.g. `font-family`) to prevent CSS-string breakout.
 */
export function sanitizeCssString(value: string): string {
  return value.replace(/[^\p{L}\p{N} _\-'.]/gu, "");
}

const FONT_FACE_STYLE_ID = "theme-font-faces";

/** Remote font URLs whose @font-face is already injected. */
const injectedUrls = new Set<string>();

/**
 * Inject a `@font-face` rule registering `family` at `url`. Idempotent per
 * URL. The URL and family are event-sourced (themes come from other users'
 * events), so both are sanitized before touching CSS.
 */
function injectFontFace(family: string, url: string): void {
  if (injectedUrls.has(url)) return;
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return;

  let style = document.getElementById(FONT_FACE_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = FONT_FACE_STYLE_ID;
    document.head.appendChild(style);
  }

  const safeFamily = sanitizeCssString(family);
  style.textContent += `
@font-face {
  font-family: "${safeFamily}";
  src: url("${safeUrl}");
  font-display: swap;
}`;
  injectedUrls.add(url);
}

/**
 * Ensure a theme font is loadable and return the CSS `font-family` value to
 * apply for it (quoted family + fallback stack), or undefined when the font
 * can't be resolved to a loadable URL and would silently render the fallback
 * anyway.
 */
export function loadThemeFont(font: ThemeFont | undefined): string | undefined {
  if (!font?.family) return undefined;
  const url = font.url ?? findThemeFont(font.family)?.cdnUrl;
  if (!url) return undefined;
  injectFontFace(font.family, url);
  return `"${sanitizeCssString(font.family)}", system-ui, sans-serif`;
}

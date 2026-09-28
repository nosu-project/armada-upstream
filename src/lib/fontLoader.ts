/**
 * Theme fonts are loaded by URL via injected `@font-face` rules, and applied
 * scoped (inline on the themed container) rather than globally, so nothing
 * needs restoring on unmount.
 */

import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { findThemeFont } from "@/lib/themeFonts";

import type { ThemeFont } from "@/lib/themeEvent";

/**
 * Sanitize an event-sourced string for a double-quoted CSS context (prevents
 * CSS-string breakout). Allowlist: letters, numbers, space, `-`, `_`, `'`, `.`.
 */
export function sanitizeCssString(value: string): string {
  return value.replace(/[^\p{L}\p{N} _\-'.]/gu, "");
}

const FONT_FACE_STYLE_ID = "theme-font-faces";

const injectedUrls = new Set<string>();

/** Inject a `@font-face` rule (idempotent per URL). Inputs are event-sourced, so both are sanitized. */
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

/** CSS `font-family` value for a theme font, or undefined when it can't resolve to a loadable URL. */
export function loadThemeFont(font: ThemeFont | undefined): string | undefined {
  if (!font?.family) return undefined;
  const url = font.url ?? findThemeFont(font.family)?.cdnUrl;
  if (!url) return undefined;
  injectFontFace(font.family, url);
  return `"${sanitizeCssString(font.family)}", system-ui, sans-serif`;
}

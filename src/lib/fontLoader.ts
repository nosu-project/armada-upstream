/**
 * Theme fonts are loaded by URL via injected `@font-face` rules. A profile's
 * font is applied scoped (inline on the themed container); the app's own goes
 * through `--theme-font`, read by Tailwind's `font-sans`.
 */

import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { findThemeFont } from "@/lib/themeFonts";

import type { ThemeFont } from "@/themes";

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

/**
 * `--theme-font` value for the app-wide theme font. Catalog families only: a
 * theme adopted from someone else may name any URL, and the app font loads on
 * every launch.
 */
export function appThemeFont(font: ThemeFont | undefined): string | undefined {
  const option = font?.family ? findThemeFont(font.family) : undefined;
  if (!option) return undefined;
  injectFontFace(option.family, option.cdnUrl);
  return `"${sanitizeCssString(option.family)}"`;
}

/** CSS `font-family` value for a theme font, or undefined when it can't resolve to a loadable URL. */
export function loadThemeFont(font: ThemeFont | undefined): string | undefined {
  if (!font?.family) return undefined;
  const url = font.url ?? findThemeFont(font.family)?.cdnUrl;
  if (!url) return undefined;
  injectFontFace(font.family, url);
  return `"${sanitizeCssString(font.family)}", system-ui, sans-serif`;
}

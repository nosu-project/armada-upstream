import type { ThemeTokens } from "@/themes";

// ─── Conversion Utilities ────────────────────────────────────────────

/** Parse an HSL string like "228 20% 10%" into { h, s, l } */
export function parseHsl(hsl: string): { h: number; s: number; l: number } {
  const parts = hsl.trim().replace(/%/g, "").split(/\s+/).map(Number);
  return { h: parts[0], s: parts[1], l: parts[2] };
}

/** Format { h, s, l } back to "228 20% 10%" */
export function formatHsl(h: number, s: number, l: number): string {
  return `${Math.round(h * 10) / 10} ${Math.round(s * 10) / 10}% ${Math.round(l * 10) / 10}%`;
}

/** Convert HSL to RGB. h in [0,360], s,l in [0,100]. Returns [r,g,b] each [0,255]. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Convert RGB [0,255] to HSL { h, s, l } (h in degrees, s/l in percent). */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

/** Check whether a string looks like a valid hex color (#RGB, #RRGGBB, or without #). */
export function isValidHex(hex: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex);
}

/** Convert hex color (#RRGGBB or #RGB) to RGB. */
export function hexToRgb(hex: string): [number, number, number] {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Convert RGB to hex (#rrggbb). */
export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Convert hex color (#RRGGBB or #RGB) to an HSL string like "228 20% 10%". */
export function hexToHslString(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  return formatHsl(h, s, l);
}

/** Convert HSL string like "228 20% 10%" to hex. */
export function hslStringToHex(hsl: string): string {
  const { h, s, l } = parseHsl(hsl);
  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

// ─── Luminance & Detection ────────────────────────────────────────────

/** Relative luminance per WCAG 2.1 (0 = black, 1 = white). */
export function getLuminance(r: number, g: number, b: number): number {
  const sRGB = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
}

/** WCAG contrast ratio between two colors (each as [r,g,b]). */
export function getContrastRatio(
  rgb1: [number, number, number],
  rgb2: [number, number, number],
): number {
  const l1 = getLuminance(...rgb1);
  const l2 = getLuminance(...rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Get contrast ratio between two HSL strings. */
export function getContrastRatioHsl(hsl1: string, hsl2: string): number {
  const c1 = parseHsl(hsl1);
  const c2 = parseHsl(hsl2);
  return getContrastRatio(hslToRgb(c1.h, c1.s, c1.l), hslToRgb(c2.h, c2.s, c2.l));
}

/** Determine if an HSL background string represents a "dark" theme. */
export function isDarkTheme(backgroundHsl: string): boolean {
  const { h, s, l } = parseHsl(backgroundHsl);
  const [r, g, b] = hslToRgb(h, s, l);
  return getLuminance(r, g, b) < 0.2;
}

/** Resolve the live --background CSS variable to `"dark"` or `"light"`. */
export function getBackgroundThemeMode(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  if (!bg) return "dark";
  return isDarkTheme(bg) ? "dark" : "light";
}

// ─── Adjust HSL helpers ───────────────────────────────────────────────

/** Lighten an HSL string by a given amount (0-100). */
function lighten(hsl: string, amount: number): string {
  const { h, s, l } = parseHsl(hsl);
  return formatHsl(h, s, Math.min(100, l + amount));
}

/** Darken an HSL string by a given amount (0-100). */
function darken(hsl: string, amount: number): string {
  const { h, s, l } = parseHsl(hsl);
  return formatHsl(h, s, Math.max(0, l - amount));
}

/** Get a contrast foreground (white or near-black) for a given background. */
function contrastForeground(bgHsl: string): string {
  const { h, s, l } = parseHsl(bgHsl);
  const [r, g, b] = hslToRgb(h, s, l);
  // Choose text color by the perceptual luminance midpoint (0.5): light
  // backgrounds get dark text, dark backgrounds get white text. The previous
  // `isDarkTheme` cutoff of 0.2 was tuned for picking page backgrounds and
  // left saturated mid-tones (e.g. a vivid green at luminance ~0.34) with
  // unreadable black text.
  return getLuminance(r, g, b) > 0.5 ? "222.2 84% 4.9%" : "0 0% 100%";
}

/**
 * Composite a translucent `overlay` color (at `alpha`) over an opaque `base`,
 * returning the resulting HSL string. Equivalent to a `bg-<overlay>/<alpha>`
 * layer painted on top of an opaque `base` background — used to reproduce the
 * old hardcoded chrome overlays exactly (black/30, black/40, white/10).
 */
function overlayHsl(baseHsl: string, overlayHslStr: string, alpha: number): string {
  const b = parseHsl(baseHsl);
  const o = parseHsl(overlayHslStr);
  const [br, bg, bb] = hslToRgb(b.h, b.s, b.l);
  const [or, og, ob] = hslToRgb(o.h, o.s, o.l);
  const r = Math.round(br * (1 - alpha) + or * alpha);
  const g = Math.round(bg * (1 - alpha) + og * alpha);
  const bl = Math.round(bb * (1 - alpha) + ob * alpha);
  const { h, s, l } = rgbToHsl(r, g, bl);
  return formatHsl(h, s, l);
}

// ─── Auto-Derive Full Token Set from Core Colors ──────────────────────

/**
 * Derive all Tailwind theme tokens from 3 core colors. The Tailwind
 * "accent" token mirrors "primary"; "success" stays a fixed green.
 *
 * @param background - Background HSL string
 * @param text       - Text/foreground HSL string
 * @param primary    - Primary accent HSL string (also used as Tailwind accent)
 */
export function deriveTokensFromCore(
  background: string,
  text: string,
  primary: string,
): ThemeTokens {
  const dark = isDarkTheme(background);
  const primaryParsed = parseHsl(primary);

  // Surface colors derived from background
  const card = dark ? lighten(background, 2) : background;
  const popover = dark ? lighten(background, 2) : background;
  const secondarySurface = dark ? lighten(background, 8) : darken(background, 4);
  const muted = dark ? lighten(background, 8) : darken(background, 4);
  const border = dark
    ? formatHsl(primaryParsed.h, primaryParsed.s * 0.4, 30)
    : formatHsl(primaryParsed.h, primaryParsed.s * 0.5, 82);
  const input = border;

  // Muted foreground: a dimmer version of the main text color. Scale the
  // saturation down proportionally (rather than subtracting a flat amount,
  // which can clamp low-saturation text to a dead grey) so it keeps the
  // theme's hue and never reads as a neutral grey.
  const fg = parseHsl(text);
  const mutedFg = dark
    ? formatHsl(fg.h, Math.max(fg.s * 0.7, 12), Math.max(fg.l - 30, 40))
    : formatHsl(fg.h, Math.max(fg.s * 0.7, 18), Math.min(fg.l + 35, 55));

  // Primary/accent foregrounds: auto-contrast
  const primaryFg = contrastForeground(primary);

  // Destructive: standard red
  const destructive = dark ? "0 72% 51%" : "0 84.2% 60.2%";
  const destructiveFg = dark ? "0 0% 95%" : "210 40% 98%";

  // Success: armada keeps a fixed green pair.
  const success = dark ? "142 60% 35%" : "142 72% 29%";
  const successFg = "138 60% 94%";

  // Second neon: a phosphor-cyan counter-accent (the virtual sea's wake),
  // fixed so it stays cold against any warm primary.
  const accent2 = dark ? "180 90% 55%" : "190 85% 40%";

  // Chrome: recessed framing planes (top bar, rails, sidebars, roster, call
  // bar). Replaces the old hardcoded overlays.
  //
  // DARK: reproduce the original look *exactly* — the old chrome was an opaque
  // background with a translucent black overlay (`bg-black/30`, rail `/40`) and
  // a white hairline (`bg-white/10`). Compositing those over the background is
  // pixel-identical to what shipped, so dark is unchanged (it darkens AND
  // slightly desaturates, which the previous hue-preserving darken did not).
  //
  // LIGHT: a black overlay turns a near-white page into muddy grey, so instead
  // darken the background while keeping/boosting the theme hue — a recessed,
  // tinted plane with enough drop to separate from the page.
  let chrome: string;
  let chromeDeep: string;
  let chromeDivider: string;
  if (dark) {
    chrome = overlayHsl(background, "0 0% 0%", 0.3);
    chromeDeep = overlayHsl(background, "0 0% 0%", 0.4);
    chromeDivider = overlayHsl(background, "0 0% 100%", 0.1);
  } else {
    const bg = parseHsl(background);
    const s = Math.min(bg.s + 8, 100);
    chrome = formatHsl(bg.h, s, Math.max(bg.l - 6, 0));
    chromeDeep = formatHsl(bg.h, s, Math.max(bg.l - 9, 0));
    chromeDivider = formatHsl(bg.h, s, Math.max(bg.l - 13, 0));
  }

  return {
    background,
    foreground: text,
    card,
    cardForeground: text,
    popover,
    popoverForeground: text,
    primary,
    primaryForeground: primaryFg,
    secondary: secondarySurface,
    secondaryForeground: text,
    muted,
    mutedForeground: mutedFg,
    accent: secondarySurface,
    accentForeground: text,
    accent2,
    destructive,
    destructiveForeground: destructiveFg,
    success,
    successForeground: successFg,
    border,
    input,
    ring: primary,
    chrome,
    chromeDeep,
    chromeDivider,
  };
}

import { parseHsl, hslToRgb, rgbToHex, getContrastRatio, isDarkTheme } from "@/lib/colorUtils";

/** Minimum contrast ratio between QR modules and background for reliable scanning. */
const MIN_QR_CONTRAST = 3;

/** Saturation threshold (%) above which a color is considered "colorful". */
const COLORFUL_SAT_MIN = 15;
/** Lightness range within which a color appears visually colorful. */
const COLORFUL_L_MIN = 20;
const COLORFUL_L_MAX = 80;

/** Read a CSS custom property as a parsed HSL object, or null if unavailable. */
function readCssHsl(prop: string): { h: number; s: number; l: number } | null {
  if (typeof document === "undefined") return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
  if (!raw) return null;
  const { h, s, l } = parseHsl(raw);
  if ([h, s, l].some(isNaN)) return null;
  return { h, s, l };
}

/** Darken until the minimum contrast against `reference`; returns hex. */
function darkenToContrast(
  hsl: { h: number; s: number; l: number },
  refRgb: [number, number, number],
): string {
  let l = hsl.l;
  let rgb = hslToRgb(hsl.h, hsl.s, l);
  let ratio = getContrastRatio(rgb, refRgb);
  while (l > 0 && ratio < MIN_QR_CONTRAST) {
    l = Math.max(0, l - 2);
    rgb = hslToRgb(hsl.h, hsl.s, l);
    ratio = getContrastRatio(rgb, refRgb);
  }
  return rgbToHex(...rgb);
}

/** Lighten until the minimum contrast against `reference`; returns hex. */
function lightenToContrast(
  hsl: { h: number; s: number; l: number },
  refRgb: [number, number, number],
): string {
  let l = hsl.l;
  let rgb = hslToRgb(hsl.h, hsl.s, l);
  let ratio = getContrastRatio(rgb, refRgb);
  while (l < 100 && ratio < MIN_QR_CONTRAST) {
    l = Math.min(100, l + 2);
    rgb = hslToRgb(hsl.h, hsl.s, l);
    ratio = getContrastRatio(rgb, refRgb);
  }
  return rgbToHex(...rgb);
}

/**
 * Prefer primary (brand color); use foreground only if it's colorful and has
 * >1.5x the contrast against the QR background.
 */
function pickModuleColor(
  primary: { h: number; s: number; l: number },
  foreground: { h: number; s: number; l: number } | null,
  bgRgb: [number, number, number],
): { h: number; s: number; l: number } {
  const fgIsColorful = foreground
    && foreground.s >= COLORFUL_SAT_MIN
    && foreground.l >= COLORFUL_L_MIN
    && foreground.l <= COLORFUL_L_MAX;

  if (!fgIsColorful) return primary;

  const primaryRgb = hslToRgb(primary.h, primary.s, primary.l);
  const fgRgb = hslToRgb(foreground.h, foreground.s, foreground.l);
  const primaryContrast = getContrastRatio(primaryRgb, bgRgb);
  const fgContrast = getContrastRatio(fgRgb, bgRgb);

  return fgContrast > primaryContrast * 1.5 ? foreground : primary;
}

/**
 * QR module/background colors from the active theme. Light: white background;
 * dark: `--background`. Modules use {@link pickModuleColor}, adjusted for contrast.
 */
export function getThemedQRColors(): { dark: string; light: string } {
  const primary = readCssHsl("--primary");
  const foreground = readCssHsl("--foreground");
  const background = readCssHsl("--background");

  if (!primary) return { dark: "#000000", light: "#ffffff" };

  const isDark = background ? isDarkTheme(`${background.h} ${background.s}% ${background.l}%`) : false;

  if (!isDark) {
    const white: [number, number, number] = [255, 255, 255];
    const module = pickModuleColor(primary, foreground, white);
    return { dark: darkenToContrast(module, white), light: "#ffffff" };
  }

  if (!background) return { dark: "#ffffff", light: "#000000" };
  const bgRgb = hslToRgb(background.h, background.s, background.l);
  const module = pickModuleColor(primary, foreground, bgRgb);
  return {
    dark: lightenToContrast(module, bgRgb),
    light: rgbToHex(...bgRgb),
  };
}

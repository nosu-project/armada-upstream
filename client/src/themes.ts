import { deriveTokensFromCore } from "@/lib/colorUtils";

/**
 * The 3 core colors that define a theme. All other Tailwind tokens are
 * derived automatically from these via `deriveTokensFromCore`.
 */
export interface CoreThemeColors {
  /** Background color (HSL string, e.g. "222 18% 9%") */
  background: string;
  /** Text/foreground color */
  text: string;
  /** Primary accent color (buttons, links, focus rings) */
  primary: string;
}

/**
 * Complete theme configuration. Wraps CoreThemeColors with an optional
 * title. Stored in `AppConfig.customTheme`.
 */
export interface ThemeConfig {
  /** Theme name. */
  title?: string;
  /** The 3 core colors. */
  colors: CoreThemeColors;
}

/**
 * Configured light and dark themes. When set in AppConfig these override
 * the builtin themes for "light" and "dark" modes.
 */
export interface ThemesConfig {
  light: ThemeConfig;
  dark: ThemeConfig;
}

/**
 * Full set of CSS token values used by Tailwind. Derived from
 * CoreThemeColors via `deriveTokensFromCore`.
 */
export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  success: string;
  successForeground: string;
  border: string;
  input: string;
  ring: string;
}

/**
 * Builtin themes whose colors are defined at build time. These mirror the
 * static values that previously lived in `index.css` so the default look
 * is unchanged. Self-hosters can customize these before building.
 */
export const builtinThemes: Record<"light" | "dark", CoreThemeColors> = {
  light: {
    background: "220 18% 97%",
    text: "224 25% 12%",
    primary: "235 70% 58%",
  },
  dark: {
    background: "222 18% 9%",
    text: "220 14% 92%",
    primary: "235 80% 68%",
  },
};

/** Metadata for a theme preset. */
export interface ThemePreset {
  /** Display label. */
  label: string;
  /** Emoji shown in compact theme pickers. */
  emoji: string;
  /** Whether to surface in compact pickers. All presets appear in settings. */
  featured?: boolean;
  /** The 3 core colors. */
  colors: CoreThemeColors;
}

/**
 * Named theme presets. Selecting one sets `theme` to "custom" and applies
 * the preset's core colors to `customTheme`.
 */
export const themePresets: Record<string, ThemePreset> = {
  midnight: {
    label: "Midnight",
    emoji: "🌃",
    featured: true,
    colors: { background: "222 47% 8%", text: "213 31% 91%", primary: "217 91% 60%" },
  },
  ocean: {
    label: "Ocean",
    emoji: "🌊",
    featured: true,
    colors: { background: "202 60% 9%", text: "190 30% 92%", primary: "190 90% 50%" },
  },
  forest: {
    label: "Forest",
    emoji: "🌲",
    featured: true,
    colors: { background: "150 25% 8%", text: "140 20% 92%", primary: "142 70% 45%" },
  },
  ember: {
    label: "Ember",
    emoji: "🔥",
    featured: true,
    colors: { background: "20 30% 8%", text: "30 25% 92%", primary: "18 90% 55%" },
  },
  grape: {
    label: "Grape",
    emoji: "🍇",
    featured: true,
    colors: { background: "270 30% 9%", text: "270 20% 93%", primary: "270 80% 65%" },
  },
  rose: {
    label: "Rose",
    emoji: "🌹",
    featured: true,
    colors: { background: "340 25% 9%", text: "340 20% 93%", primary: "340 85% 62%" },
  },
  slate: {
    label: "Slate",
    emoji: "🪨",
    colors: { background: "215 16% 12%", text: "210 16% 90%", primary: "210 16% 70%" },
  },
  gold: {
    label: "Gold",
    emoji: "🪙",
    colors: { background: "40 25% 8%", text: "45 30% 92%", primary: "43 90% 55%" },
  },
  mint: {
    label: "Mint",
    emoji: "🌿",
    colors: { background: "160 30% 96%", text: "165 30% 14%", primary: "165 70% 38%" },
  },
  sky: {
    label: "Sky",
    emoji: "☁️",
    colors: { background: "205 60% 97%", text: "210 35% 16%", primary: "205 85% 50%" },
  },
  sand: {
    label: "Sand",
    emoji: "🏜️",
    colors: { background: "40 40% 96%", text: "30 30% 16%", primary: "28 75% 50%" },
  },
  bubblegum: {
    label: "Bubblegum",
    emoji: "🍬",
    colors: { background: "320 70% 97%", text: "325 35% 18%", primary: "325 80% 58%" },
  },
};

// ─── CSS variable mapping ─────────────────────────────────────────────

/** Map a ThemeTokens key to its CSS custom-property name (camelCase → kebab). */
export function toThemeVar(key: keyof ThemeTokens): string {
  return "--" + key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

/** Build a `:root { --token: value; }` CSS string from a full token set. */
export function buildThemeCss(tokens: ThemeTokens): string {
  const decls = (Object.keys(tokens) as Array<keyof ThemeTokens>)
    .map((key) => `  ${toThemeVar(key)}: ${tokens[key]};`)
    .join("\n");
  return `:root {\n${decls}\n}`;
}

/** Derive the full token set from 3 core colors. */
export function coreToTokens(colors: CoreThemeColors): ThemeTokens {
  return deriveTokensFromCore(colors.background, colors.text, colors.primary);
}

/** Build the injected `<style id="theme-vars">` CSS from 3 core colors. */
export function buildThemeCssFromCore(colors: CoreThemeColors): string {
  return buildThemeCss(coreToTokens(colors));
}

// ─── Resolution ───────────────────────────────────────────────────────

/** Resolve a theme mode to a concrete light/dark/custom value. */
export function resolveTheme(theme: "light" | "dark" | "system" | "custom"): "light" | "dark" | "custom" {
  if (theme === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

/** Resolve a light/dark mode to its core colors, honoring per-mode overrides. */
export function resolveThemeColors(
  mode: "light" | "dark",
  themes?: ThemesConfig,
): CoreThemeColors {
  return themes?.[mode]?.colors ?? builtinThemes[mode];
}

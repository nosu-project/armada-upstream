import { Check, Palette } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/hooks/useTheme";
import { useUserThemes } from "@/hooks/useUserThemes";
import { hexToHslString, hslStringToHex } from "@/lib/colorUtils";
import { cn } from "@/lib/utils";
import {
  builtinThemes,
  coreToTokens,
  themePresets,
  type CoreThemeColors,
  type ThemeConfig,
} from "@/themes";

import type { Theme } from "@/contexts/AppContext";

/** A small preview swatch showing a theme's background + primary. */
function Swatch({ colors }: { colors: CoreThemeColors }) {
  const tokens = coreToTokens(colors);
  return (
    <div
      className="size-full rounded-[inherit] flex items-end p-1.5 gap-1"
      style={{ backgroundColor: `hsl(${tokens.background})` }}
    >
      <span className="size-3 rounded-full" style={{ backgroundColor: `hsl(${tokens.primary})` }} />
      <span className="size-3 rounded-full" style={{ backgroundColor: `hsl(${tokens.secondary})` }} />
      <span className="flex-1 h-1.5 rounded-full" style={{ backgroundColor: `hsl(${tokens.muted})` }} />
    </div>
  );
}

interface TileProps {
  label: string;
  emoji?: string;
  colors: CoreThemeColors;
  active: boolean;
  onClick: () => void;
}

function ThemeTile({ label, emoji, colors, active, onClick }: TileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group relative flex flex-col items-stretch gap-1.5 rounded-xl border-2 p-1.5 text-left transition-all",
        active ? "border-primary" : "border-transparent hover:border-border",
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border">
        <Swatch colors={colors} />
        {active && (
          <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" />
          </span>
        )}
      </div>
      <span className="px-0.5 text-xs font-medium truncate">
        {emoji ? `${emoji} ` : ""}{label}
      </span>
    </button>
  );
}

/**
 * Theme picker: System / Light / Dark, named presets, and a custom theme
 * builder. Adapted from Ditto's ThemeSelector for Armada's web context.
 */
export function ThemeSelector() {
  const { theme, customTheme, setTheme, applyCustomTheme } = useTheme();
  const { data: userThemes, isLoading: userThemesLoading } = useUserThemes();
  const [builderOpen, setBuilderOpen] = useState(false);

  const presetKeys = Object.keys(themePresets);
  const activeColorsJson = theme === "custom" && customTheme
    ? JSON.stringify(customTheme.colors)
    : undefined;
  const activePresetKey = activeColorsJson
    ? presetKeys.find((k) => JSON.stringify(themePresets[k].colors) === activeColorsJson)
    : undefined;
  const activeUserThemeId = activeColorsJson && !activePresetKey
    ? userThemes?.find((t) => JSON.stringify(t.colors) === activeColorsJson)?.identifier
    : undefined;
  const isCustomBuild = theme === "custom" && !activePresetKey && !activeUserThemeId;

  const selectMode = (mode: Theme) => setTheme(mode);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">Base</h3>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <ThemeTile
            label="System"
            emoji="💻"
            colors={builtinThemes.dark}
            active={theme === "system"}
            onClick={() => selectMode("system")}
          />
          <ThemeTile
            label="Light"
            emoji="☀️"
            colors={builtinThemes.light}
            active={theme === "light"}
            onClick={() => selectMode("light")}
          />
          <ThemeTile
            label="Dark"
            emoji="🌙"
            colors={builtinThemes.dark}
            active={theme === "dark"}
            onClick={() => selectMode("dark")}
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">Presets</h3>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {presetKeys.map((key) => {
            const preset = themePresets[key];
            return (
              <ThemeTile
                key={key}
                label={preset.label}
                emoji={preset.emoji}
                colors={preset.colors}
                active={activePresetKey === key}
                onClick={() => applyCustomTheme({ title: preset.label, colors: preset.colors })}
              />
            );
          })}
        </div>
      </div>

      {(userThemesLoading || (userThemes && userThemes.length > 0)) && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            My themes
          </h3>
          {userThemesLoading ? (
            <p className="text-xs text-muted-foreground">Loading your themes…</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {userThemes!.map((t) => (
                <ThemeTile
                  key={t.identifier || t.title}
                  label={t.title}
                  colors={t.colors}
                  active={activeUserThemeId === t.identifier}
                  onClick={() => applyCustomTheme({ title: t.title, colors: t.colors })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <Button className="w-full clip-corner-lg" onClick={() => setBuilderOpen(true)}>
        <Palette className="size-4 mr-2" />
        {isCustomBuild ? "Edit custom theme" : "Create a custom theme"}
      </Button>

      <ThemeBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        initial={isCustomBuild ? customTheme : undefined}
        onApply={applyCustomTheme}
      />
    </div>
  );
}

interface BuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ThemeConfig;
  onApply: (config: ThemeConfig) => void;
}

const STARTER: CoreThemeColors = { background: "222 18% 9%", text: "220 14% 92%", primary: "235 80% 68%" };

function ThemeBuilderDialog({ open, onOpenChange, initial, onApply }: BuilderProps) {
  const [colors, setColors] = useState<CoreThemeColors>(initial?.colors ?? STARTER);
  const [title, setTitle] = useState(initial?.title ?? "My theme");

  const update = (channel: keyof CoreThemeColors) => (hex: string) =>
    setColors((c) => ({ ...c, [channel]: hexToHslString(hex) }));

  const tokens = coreToTokens(colors);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Custom theme">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
            <Palette className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            custom theme
          </h2>
          <p className="text-sm text-muted-foreground">
            Pick three colors — every other shade is derived automatically.
          </p>
        </div>

        <div className="mt-6 space-y-5">
          {/* Live preview */}
          <div
            className="clip-corner-lg p-4 space-y-3"
            style={{ backgroundColor: `hsl(${tokens.background})`, color: `hsl(${tokens.foreground})` }}
          >
            <div className="flex items-center gap-2">
              <span className="size-8 rounded-full" style={{ backgroundColor: `hsl(${tokens.primary})` }} />
              <div className="flex-1">
                <div className="text-sm font-semibold">{title || "Preview"}</div>
                <div className="text-xs" style={{ color: `hsl(${tokens.mutedForeground})` }}>
                  The quick brown fox.
                </div>
              </div>
              <span
                className="clip-corner-lg px-2 py-1 text-xs font-medium"
                style={{ backgroundColor: `hsl(${tokens.primary})`, color: `hsl(${tokens.primaryForeground})` }}
              >
                Button
              </span>
            </div>
            <div className="rounded-md p-2 text-xs" style={{ backgroundColor: `hsl(${tokens.secondary})` }}>
              A muted surface row.
            </div>
          </div>

          <div className="flex items-start justify-around">
            <ColorPicker label="Background" value={hslStringToHex(colors.background)} onChange={update("background")} />
            <ColorPicker label="Text" value={hslStringToHex(colors.text)} onChange={update("text")} />
            <ColorPicker label="Primary" value={hslStringToHex(colors.primary)} onChange={update("primary")} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="theme-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Name
            </Label>
            <Input id="theme-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} />
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1 clip-corner-lg"
              onClick={() => {
                onApply({ title: title.trim() || "Custom", colors });
                onOpenChange(false);
              }}
            >
              Apply theme
            </Button>
          </div>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}

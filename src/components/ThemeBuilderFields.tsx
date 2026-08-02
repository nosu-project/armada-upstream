import { ColorPicker } from "@/components/ui/color-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hexToHslString, hslStringToHex } from "@/lib/colorUtils";
import { coreToTokens, type CoreThemeColors } from "@/themes";

interface ThemeBuilderFieldsProps {
  colors: CoreThemeColors;
  onColorsChange: (colors: CoreThemeColors) => void;
  title: string;
  onTitleChange: (title: string) => void;
  /** Placeholder for the name field. Omitted where the name is pre-filled. */
  placeholder?: string;
}

/**
 * The custom-theme builder body: a live preview, the three core color pickers,
 * and the name field. Shared verbatim by the Settings → Appearance builder and
 * the Discover theme creator so the two cannot drift apart. The surrounding
 * dialog frame and its actions belong to each caller.
 */
export function ThemeBuilderFields({
  colors,
  onColorsChange,
  title,
  onTitleChange,
  placeholder,
}: ThemeBuilderFieldsProps) {
  const update = (channel: keyof CoreThemeColors) => (hex: string) =>
    onColorsChange({ ...colors, [channel]: hexToHslString(hex) });

  const tokens = coreToTokens(colors);

  return (
    <div className="space-y-5">
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
        <Input
          id="theme-title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder={placeholder}
          maxLength={40}
        />
      </div>
    </div>
  );
}

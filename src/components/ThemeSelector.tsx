import { Check, Loader2, Palette, Pencil, Share2 } from "lucide-react";
import { useState } from "react";

import { ThemeCreatorDialog } from "@/components/discover/ThemeCreatorDialog";
import { ThemeBackgroundField } from "@/components/ThemeBackgroundField";
import { ThemeBuilderFields } from "@/components/ThemeBuilderFields";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { ToastAction } from "@/components/ui/toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCopyNaddrLink } from "@/hooks/useNaddrLink";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useTheme } from "@/hooks/useTheme";
import { useUserThemes, type UserTheme } from "@/hooks/useUserThemes";
import { toast } from "@/hooks/useToast";
import { buildThemeDefinitionEvent } from "@/lib/themeEvent";
import { cn } from "@/lib/utils";
import {
  builderStarterColors,
  builtinThemes,
  coreToTokens,
  themePresets,
  type CoreThemeColors,
  type ThemeBackground,
  type ThemeConfig,
} from "@/themes";

import type { Theme } from "@/contexts/AppContext";

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
  /** Shows an edit control on the tile (the user's own library themes). */
  onEdit?: () => void;
}

function ThemeTile({ label, emoji, colors, active, onClick, onEdit }: TileProps) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          "flex w-full flex-col items-stretch gap-1.5 rounded-xl border-2 p-1.5 text-left transition-all",
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
        <span className={cn("px-0.5 text-xs font-medium truncate", onEdit && "pr-7")}>
          {emoji ? `${emoji} ` : ""}{label}
        </span>
      </button>
      {onEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute bottom-0.5 right-0.5 size-7 touch:size-11 text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          aria-label={`Edit ${label}`}
          title="Edit theme"
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/** Theme picker, adapted from Ditto's ThemeSelector. */
export function ThemeSelector() {
  const { theme, customTheme, setTheme, applyCustomTheme } = useTheme();
  const { data: userThemes, isLoading: userThemesLoading } = useUserThemes();
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent, isPending: sharing } = useNostrPublish();
  const copyLinkFor = useCopyNaddrLink();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingTheme, setEditingTheme] = useState<UserTheme | undefined>();

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

  // Someone else's theme is already on Discover under their name.
  const canShare = theme === "custom" && !!customTheme && !customTheme.source;
  const shareTheme = async () => {
    if (!customTheme) return;
    const title = customTheme.title || "My theme";
    // Re-sharing updates the library theme of the same name instead of adding another.
    const existing = userThemes?.find((t) => t.title === title && !t.source);
    const sameAsExisting = !!existing
      && JSON.stringify([existing.colors, existing.background]) === JSON.stringify([customTheme.colors, customTheme.background]);
    try {
      const event = sameAsExisting
        ? existing.event
        : await publishEvent({
          ...buildThemeDefinitionEvent(title, customTheme.colors, existing?.identifier, {
            background: customTheme.background,
            font: existing?.font,
            titleFont: existing?.titleFont,
            description: existing?.description,
          }),
          prev: existing?.event,
        });
      const copyLink = copyLinkFor(event);
      toast({
        title: sameAsExisting ? "Already shared" : "Theme shared",
        description: "It's now discoverable by others.",
        ...(copyLink && {
          action: (
            <ToastAction altText="Copy theme link" onClick={copyLink}>
              Copy link
            </ToastAction>
          ),
        }),
      });
    } catch (e) {
      toast({
        title: "Couldn't share theme",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

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
                  onClick={() => applyCustomTheme({
                    title: t.title,
                    colors: t.colors,
                    ...(t.background && { background: t.background }),
                    ...(t.source && { source: t.source }),
                  })}
                  onEdit={() => setEditingTheme(t)}
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

      {user && canShare && (
        <Button
          variant="outline"
          className="w-full clip-corner-lg"
          onClick={shareTheme}
          disabled={sharing}
        >
          {sharing ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Share2 className="size-4 mr-2" />}
          Share to Discover
        </Button>
      )}

      <ThemeBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        initial={isCustomBuild ? customTheme : undefined}
        onApply={applyCustomTheme}
      />

      {editingTheme && (
        <ThemeCreatorDialog
          open
          onOpenChange={(open) => { if (!open) setEditingTheme(undefined); }}
          editing={editingTheme}
        />
      )}
    </div>
  );
}

interface BuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ThemeConfig;
  onApply: (config: ThemeConfig) => void;
}

function ThemeBuilderDialog({ open, onOpenChange, initial, onApply }: BuilderProps) {
  const [colors, setColors] = useState<CoreThemeColors>(initial?.colors ?? builderStarterColors);
  const [title, setTitle] = useState(initial?.title ?? "My theme");
  const [background, setBackground] = useState<ThemeBackground | undefined>(initial?.background);
  const [uploading, setUploading] = useState(false);

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
          <ThemeBuilderFields
            colors={colors}
            onColorsChange={setColors}
            title={title}
            onTitleChange={setTitle}
          />

          <ThemeBackgroundField value={background} onChange={setBackground} onUploadingChange={setUploading} />

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="ghost" className="flex-1 clip-corner-lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1 clip-corner-lg"
              disabled={uploading}
              onClick={() => {
                // Built here, so no creator credit carries over.
                onApply({ title: title.trim() || "Custom", colors, ...(background && { background }) });
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

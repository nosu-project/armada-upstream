import { Loader2 } from "lucide-react";
import { useState } from "react";

import { ThemeBackgroundField } from "@/components/ThemeBackgroundField";
import { ThemeBuilderFields } from "@/components/ThemeBuilderFields";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePublishProfileTheme } from "@/hooks/usePublishProfileTheme";
import { toast } from "@/hooks/useToast";
import { loadThemeFont } from "@/lib/fontLoader";
import { themeFontOptions, type ThemeFontCategory } from "@/lib/themeFonts";

import { builderStarterColors, type CoreThemeColors } from "@/themes";
import type { DittoTheme, ThemeBackground } from "@/lib/themeEvent";

const CATEGORY_LABELS: Record<ThemeFontCategory, string> = {
  sans: "Sans serif",
  serif: "Serif",
  mono: "Monospace",
  display: "Display",
  handwriting: "Handwriting",
};

const FONT_CATEGORIES: ThemeFontCategory[] = ["sans", "serif", "mono", "display", "handwriting"];

/** Radix Select forbids an empty-string value. */
const DEFAULT_FONT = "__default__";

/** Edit and publish the profile theme (kind 16767, Ditto-compatible). Save and Remove are the only publishes. */
export function ProfileThemeEditor({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current?: DittoTheme;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Profile theme">
        {open && <ThemeEditorForm current={current} onDone={() => onOpenChange(false)} />}
      </ChromeDialogContent>
    </Dialog>
  );
}

function FontSelect({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (family: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex-1 space-y-1.5 min-w-0">
      <Label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <Select value={value || DEFAULT_FONT} onValueChange={(v) => onChange(v === DEFAULT_FONT ? "" : v)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_FONT}>{placeholder}</SelectItem>
          {FONT_CATEGORIES.map((cat) => (
            <SelectGroup key={cat}>
              <SelectLabel>{CATEGORY_LABELS[cat]}</SelectLabel>
              {themeFontOptions
                .filter((f) => f.category === cat)
                .map((f) => (
                  <SelectItem
                    key={f.family}
                    value={f.family}
                    style={{ fontFamily: loadThemeFont({ family: f.family }) }}
                  >
                    {f.family}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ThemeEditorForm({ current, onDone }: { current?: DittoTheme; onDone: () => void }) {
  const { save, remove, isPending } = usePublishProfileTheme();
  const [uploading, setUploading] = useState(false);

  const [colors, setColors] = useState<CoreThemeColors>(current?.colors ?? builderStarterColors);
  const [title, setTitle] = useState(current?.title === "Untitled theme" ? "" : current?.title ?? "");
  const [fontFamily, setFontFamily] = useState(current?.font?.family ?? "");
  const [titleFontFamily, setTitleFontFamily] = useState(current?.titleFont?.family ?? "");
  const [background, setBackground] = useState<ThemeBackground | undefined>(current?.background);

  const unchanged = !!current
    && JSON.stringify([colors, background, fontFamily, titleFontFamily])
      === JSON.stringify([current.colors, current.background, current.font?.family ?? "", current.titleFont?.family ?? ""]);

  const doSave = async () => {
    try {
      await save({
        colors,
        title: title.trim() || undefined,
        font: fontFamily ? { family: fontFamily } : undefined,
        titleFont: titleFontFamily ? { family: titleFontFamily } : undefined,
        background,
        description: current?.description,
        // The creator stays credited only while the theme is still their work.
        sourceRef: unchanged ? current?.sourceRef : undefined,
        source: unchanged ? current?.source : undefined,
      });
      toast({ title: "Profile theme saved" });
      onDone();
    } catch (e) {
      toast({
        title: "Couldn't save theme",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  const doRemove = async () => {
    try {
      await remove();
      toast({ title: "Profile theme removed" });
      onDone();
    } catch (e) {
      toast({
        title: "Couldn't remove theme",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Anyone viewing your profile sees it in these colors, fonts, and
        background. Published publicly (works in Ditto too).
      </p>

      <ThemeBuilderFields
        colors={colors}
        onColorsChange={setColors}
        title={title}
        onTitleChange={setTitle}
        placeholder="My theme"
      />

      <div className="flex gap-3">
        <FontSelect
          id="profile-theme-font"
          label="Font"
          value={fontFamily}
          onChange={setFontFamily}
          placeholder="Default"
        />
        <FontSelect
          id="profile-theme-title-font"
          label="Name font"
          value={titleFontFamily}
          onChange={setTitleFontFamily}
          placeholder={fontFamily || "Default"}
        />
      </div>

      <ThemeBackgroundField value={background} onChange={setBackground} onUploadingChange={setUploading} />

      <div className="space-y-2">
        <Button className="w-full clip-corner-lg" onClick={doSave} disabled={isPending || uploading}>
          {isPending && <Loader2 className="size-4 animate-spin" />}
          Save theme
        </Button>
        {current && (
          <Button
            variant="ghost"
            className="w-full text-muted-foreground hover:text-destructive"
            onClick={doRemove}
            disabled={isPending}
          >
            Remove theme
          </Button>
        )}
      </div>
    </div>
  );
}

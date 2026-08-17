import { Image as ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";

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
import { useUploadFile } from "@/hooks/useUploadFile";
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

/** The `value` a Select uses for "no custom font" (Radix forbids an empty string). */
const DEFAULT_FONT = "__default__";

/**
 * Edit and publish the user's profile theme (kind 16767, Ditto-compatible):
 * the 3 core colors, body/title fonts from the shared catalog, and a
 * background image (Blossom upload, cover or tiled). Save and Remove are the
 * only publishes, both explicit.
 */
export function ProfileThemeEditor({
  open,
  onOpenChange,
  current,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The currently published theme, to seed the form. */
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
                    // Each option renders in its own face — the closest thing
                    // to a preview a dropdown can offer.
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
  const { mutateAsync: uploadFile, isPending: uploading } = useUploadFile();
  const fileRef = useRef<HTMLInputElement>(null);

  const [colors, setColors] = useState<CoreThemeColors>(current?.colors ?? builderStarterColors);
  const [title, setTitle] = useState(current?.title === "Untitled theme" ? "" : current?.title ?? "");
  const [fontFamily, setFontFamily] = useState(current?.font?.family ?? "");
  const [titleFontFamily, setTitleFontFamily] = useState(current?.titleFont?.family ?? "");
  const [background, setBackground] = useState<ThemeBackground | undefined>(current?.background);

  const pickBackground = async (file: File | undefined) => {
    if (!file) return;
    try {
      const tags = await uploadFile(file);
      const url = tags[0][1];
      const mimeType = tags.find(([n]) => n === "m")?.[1];
      const dimensions = tags.find(([n]) => n === "dim")?.[1];
      setBackground({ url, mode: background?.mode ?? "cover", mimeType, dimensions });
    } catch (e) {
      toast({
        title: "Couldn't upload background",
        description: e instanceof Error ? e.message : "Upload failed.",
        variant: "destructive",
      });
    }
  };

  const doSave = async () => {
    try {
      await save({
        colors,
        title: title.trim() || undefined,
        font: fontFamily ? { family: fontFamily } : undefined,
        titleFont: titleFontFamily ? { family: titleFontFamily } : undefined,
        background,
        description: current?.description,
        sourceRef: current?.sourceRef,
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

      <div className="space-y-1.5">
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Background image
        </Label>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void pickBackground(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <div className="flex items-center gap-2">
          {background?.url ? (
            <div
              className="size-11 shrink-0 clip-corner-lg bg-cover bg-center bg-secondary"
              style={{ backgroundImage: `url("${background.url}")` }}
            />
          ) : (
            <div className="flex size-11 shrink-0 items-center justify-center clip-corner-lg bg-secondary text-muted-foreground">
              <ImageIcon className="size-5" />
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="clip-corner-lg"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {background?.url ? "Replace" : "Upload"}
          </Button>
          {background?.url && (
            <>
              <Select
                value={background.mode ?? "cover"}
                onValueChange={(v) =>
                  setBackground({ ...background, mode: v === "tile" ? "tile" : "cover" })
                }
              >
                <SelectTrigger className="h-9 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cover">Fill</SelectItem>
                  <SelectItem value="tile">Tile</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground hover:text-destructive"
                aria-label="Remove background"
                onClick={() => setBackground(undefined)}
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>

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

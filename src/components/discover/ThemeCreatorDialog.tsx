import { Loader2, Palette, Trash2 } from "lucide-react";
import { useState } from "react";

import { ThemeBackgroundField } from "@/components/ThemeBackgroundField";
import { ThemeBuilderFields } from "@/components/ThemeBuilderFields";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ToastAction } from "@/components/ui/toast";
import { useCopyNaddrLink } from "@/hooks/useNaddrLink";
import { useTheme } from "@/hooks/useTheme";
import { useThemeLibrary } from "@/hooks/useThemeLibrary";
import { toast } from "@/hooks/useToast";

import { builderStarterColors, type CoreThemeColors, type ThemeBackground } from "@/themes";
import type { UserTheme } from "@/hooks/useUserThemes";

/**
 * Create, edit or delete a shareable theme (kind 36767). Never touches the
 * active profile theme (kind 16767). `editing` is one of the user's own themes.
 */
export function ThemeCreatorDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: UserTheme;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={editing ? "Edit theme" : "Create theme"}>
        <ThemeCreatorForm editing={editing} onDone={() => onOpenChange(false)} />
      </ChromeDialogContent>
    </Dialog>
  );
}

function ThemeCreatorForm({ editing, onDone }: { editing?: UserTheme; onDone: () => void }) {
  const { publishTheme, deleteTheme, isPending: publishing } = useThemeLibrary();
  const { applyCustomTheme } = useTheme();
  const copyLinkFor = useCopyNaddrLink();
  const [colors, setColors] = useState<CoreThemeColors>(editing?.colors ?? builderStarterColors);
  const [name, setName] = useState(editing?.title ?? "");
  const [background, setBackground] = useState<ThemeBackground | undefined>(editing?.background);
  const [uploading, setUploading] = useState(false);
  const [applyToMine, setApplyToMine] = useState(!editing);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const named = name.trim().length > 0;
  const busy = publishing || uploading || deleting;
  const canPublish = named && !busy;

  const hint = publishing
    ? "Publishing…"
    : uploading
      ? "Uploading background…"
      : !named
        ? "Give the theme a name."
        : "Anyone will be able to find and apply this theme.";

  const publish = async () => {
    if (!canPublish) return;
    const title = name.trim();
    // A credited copy stays credited only while it is still the creator's work.
    const unchanged = !!editing
      && JSON.stringify([colors, background]) === JSON.stringify([editing.colors, editing.background]);

    let result: Awaited<ReturnType<typeof publishTheme>>;
    try {
      result = await publishTheme({
        title,
        colors,
        background,
        font: editing?.font,
        titleFont: editing?.titleFont,
        description: editing?.description,
        source: unchanged ? editing?.source : undefined,
        editing,
      });
    } catch (e) {
      toast({
        title: editing ? "Couldn't save theme" : "Couldn't publish theme",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
      return;
    }

    if (applyToMine) applyCustomTheme({ title, colors, background });

    const applied = applyToMine ? " — applied as your theme" : "";
    const syncing = result.queued ? " (syncing when the network is back)" : "";
    const copyLink = copyLinkFor(result.event);
    toast({
      title: editing ? "Theme saved" : "Theme published",
      description: `${title}${applied}${syncing}`,
      ...(copyLink && {
        action: (
          <ToastAction altText="Copy theme link" onClick={copyLink}>
            Copy link
          </ToastAction>
        ),
      }),
    });
    onDone();
  };

  const remove = async () => {
    if (!editing) return;
    setDeleting(true);
    try {
      await deleteTheme(editing);
      toast({ title: "Theme deleted", description: editing.title });
      onDone();
    } catch (e) {
      toast({
        title: "Couldn't delete theme",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
          <Palette className="size-6" />
        </div>
        <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
          {editing ? "edit theme" : "new theme"}
        </h2>
        <p className="text-sm text-muted-foreground">
          Pick three colors — every other shade is derived automatically.
        </p>
      </div>

      <ThemeBuilderFields
        colors={colors}
        onColorsChange={setColors}
        title={name}
        onTitleChange={setName}
        placeholder="My theme"
      />

      <ThemeBackgroundField value={background} onChange={setBackground} onUploadingChange={setUploading} />

      <div className="space-y-2">
        <Label className="flex cursor-pointer items-center gap-2 py-1 text-sm font-normal text-muted-foreground">
          <Checkbox
            checked={applyToMine}
            onCheckedChange={(v) => setApplyToMine(v === true)}
            className="shrink-0"
          />
          Apply as my theme
        </Label>
        <Button className="w-full clip-corner-lg" onClick={publish} disabled={!canPublish}>
          {publishing && <Loader2 className="size-4 animate-spin" />}
          {editing ? "Save changes" : "Publish theme"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">{hint}</p>
        {editing && (
          <Button
            variant="ghost"
            className="w-full text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Delete theme
          </Button>
        )}
      </div>

      {editing && (
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{editing.title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                It's removed from your themes and from Discover. Anyone already using it keeps their copy.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void remove()}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

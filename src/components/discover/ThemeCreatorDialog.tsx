import { Loader2, Palette } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ThemeBuilderFields } from "@/components/ThemeBuilderFields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useTheme } from "@/hooks/useTheme";
import { toast } from "@/hooks/useToast";
import { buildThemeDefinitionEvent } from "@/lib/themeEvent";

import { builderStarterColors, type CoreThemeColors } from "@/themes";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Create and publish a shareable theme (kind 36767) from Discover. The body is
 * the same builder Settings → Appearance uses; publishing makes the theme
 * discoverable by anyone. Only ever runs on an explicit user action, and never
 * touches the active profile theme (kind 16767) — that stays a separate action.
 */
export function ThemeCreatorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title="Create theme">
        <ThemeCreatorForm onDone={() => onOpenChange(false)} />
      </ChromeDialogContent>
    </Dialog>
  );
}

function ThemeCreatorForm({ onDone }: { onDone: () => void }) {
  const { mutateAsync: publishEvent, isPending: publishing } = useNostrPublish();
  const { applyCustomTheme } = useTheme();
  const queryClient = useQueryClient();
  const [colors, setColors] = useState<CoreThemeColors>(builderStarterColors);
  const [name, setName] = useState("");
  const [applyToMine, setApplyToMine] = useState(true);

  const named = name.trim().length > 0;
  const canPublish = named && !publishing;

  const hint = publishing
    ? "Publishing…"
    : !named
      ? "Give the theme a name."
      : "Anyone will be able to find and apply this theme.";

  const publish = async () => {
    if (!canPublish) return;
    const title = name.trim();
    try {
      const event = await publishEvent(buildThemeDefinitionEvent(title, colors));

      // Show the new theme by seeding the cache rather than refetching. An
      // immediate refetch races relay indexing on a 6s budget, so it can come
      // back with LESS than is already on screen — the grid appearing to empty
      // itself the moment you publish. The stale mark (without a refetch) lets
      // the next natural fetch reconcile with the relays. Only the unsearched
      // query is seeded; a search result has its own server-side criteria.
      queryClient.setQueriesData<NostrRumor[]>(
        { queryKey: ["discover", "themes"], predicate: (q) => q.queryKey[4] === "" },
        (prev) => (prev ? [event, ...prev.filter((e) => e.id !== event.id)] : prev),
      );
      void queryClient.invalidateQueries({ queryKey: ["discover", "themes"], refetchType: "none" });
      // The same theme belongs in the Settings → Appearance library.
      void queryClient.invalidateQueries({ queryKey: ["user-themes"] });

      if (applyToMine) {
        applyCustomTheme({ title, colors });
        toast({ title: "Theme published", description: `${title} — applied as your theme` });
      } else {
        toast({ title: "Theme published", description: title });
      }
      onDone();
    } catch (e) {
      toast({
        title: "Couldn't publish theme",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center clip-corner-lg bg-primary/15 text-primary">
          <Palette className="size-6" />
        </div>
        <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
          new theme
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
          Publish theme
        </Button>
        <p className="text-center text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

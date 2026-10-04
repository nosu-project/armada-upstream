import { Loader2, Palette } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToastAction } from "@/components/ui/toast";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useTheme } from "@/hooks/useTheme";
import { toast } from "@/hooks/useToast";
import { useRehostFile } from "@/hooks/useUploadFile";
import { getDisplayName } from "@/lib/getDisplayName";
import { clearThemePreview, useThemePreview } from "@/lib/themePreview";

import type { ThemeConfig } from "@/themes";

/**
 * Confirm bar for a theme being tried on. Previewing stores nothing; "Use this
 * theme" adopts it. Offers to keep the user's own copy of a borrowed background
 * so the creator can't later swap or delete it.
 */
export function ThemePreviewBar() {
  const preview = useThemePreview();
  const { pathname } = useLocation();
  const { user } = useCurrentUser();
  const { theme, customTheme, setTheme, applyCustomTheme } = useTheme();
  const rehost = useRehostFile();
  const [keepBackground, setKeepBackground] = useState(true);

  const config = preview?.config;
  const source = config?.source && config.source.pubkey !== user?.pubkey ? config.source : undefined;
  const author = useAuthor(source?.pubkey);
  const authorName = source ? getDisplayName(author.data?.metadata, source.pubkey) : undefined;
  const offerRehost = !!user && !!source && !!config?.background;

  // A preview belongs to the page it was started on.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname !== lastPath.current) {
      lastPath.current = pathname;
      clearThemePreview();
    }
  }, [pathname]);

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearThemePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  if (!config) return null;

  const title = config.title || "Untitled theme";

  const use = async () => {
    let adopted: ThemeConfig = { ...config, source };

    if (offerRehost && keepBackground && adopted.background) {
      try {
        const url = await rehost.mutateAsync(adopted.background.url);
        adopted = { ...adopted, background: { ...adopted.background, url } };
      } catch (e) {
        toast({
          title: "Couldn't copy the background",
          description: e instanceof Error ? e.message : "The theme still links to its creator's copy.",
          variant: "destructive",
        });
      }
    }

    const previous = { mode: theme, config: customTheme };
    applyCustomTheme(adopted);
    clearThemePreview();

    const undo = () => {
      if (previous.mode === "custom" && previous.config) applyCustomTheme(previous.config);
      else setTheme(previous.mode);
    };
    toast({
      title: "Theme applied",
      description: authorName ? `${title} by ${authorName}` : title,
      action: (
        <ToastAction altText="Undo theme change" onClick={undo}>
          Undo
        </ToastAction>
      ),
    });
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
      <div
        role="region"
        aria-label="Theme preview"
        className="pointer-events-auto w-full max-w-md clip-corner-lg bg-popover p-4 text-popover-foreground shadow-xl animate-in fade-in-0 slide-in-from-bottom-2"
      >
        <div className="flex items-start gap-3">
          <Palette className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Previewing {title}</p>
            {source && authorName && (
              <p className="truncate text-xs text-muted-foreground">
                by <DisplayName pubkey={source.pubkey} name={authorName} />
              </p>
            )}
          </div>
        </div>

        {offerRehost && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <Label htmlFor="theme-preview-keep-background" className="cursor-pointer text-sm font-normal">
              Keep my own copy of the background
            </Label>
            <Switch
              id="theme-preview-keep-background"
              checked={keepBackground}
              onCheckedChange={setKeepBackground}
            />
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="ghost"
            className="clip-corner-lg touch:h-11"
            onClick={clearThemePreview}
            disabled={rehost.isPending}
          >
            Cancel
          </Button>
          <Button className="clip-corner-lg touch:h-11" onClick={use} disabled={rehost.isPending}>
            {rehost.isPending && <Loader2 className="size-4 animate-spin" />}
            Use this theme
          </Button>
        </div>
      </div>
    </div>
  );
}

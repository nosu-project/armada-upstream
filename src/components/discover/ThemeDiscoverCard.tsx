import { BookmarkPlus, Check, Link2, Loader2, Palette } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { DisplayName } from "@/components/DisplayName";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNaddrLink } from "@/hooks/useNaddrLink";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { useTheme } from "@/hooks/useTheme";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { naddrPath } from "@/lib/naddrLink";
import { buildThemeDefinitionEvent, parseDittoTheme } from "@/lib/themeEvent";
import { cn } from "@/lib/utils";
import { coreToTokens } from "@/themes";

import type { NostrRumor } from "@/lib/nostrRumor";

interface ThemeDiscoverCardProps {
  /** A kind-36767 theme definition event. */
  event: NostrRumor;
  className?: string;
}

/**
 * A shareable theme (kind 36767) as a card — in the Discover grid, on its own
 * `/<naddr>` page, and wherever it's shared in chat: a live preview of its
 * core colors, the author, and three actions — Apply (set it as the app's
 * custom theme; local, publishes nothing), Save (copy it into your own theme
 * library without changing the current look) and Copy link (its `/<naddr>`
 * page, to hand to someone else). The title opens that same page.
 */
export function ThemeDiscoverCard({ event, className }: ThemeDiscoverCardProps) {
  const theme = useMemo(() => parseDittoTheme(event), [event]);
  const { customTheme, theme: mode, applyCustomTheme } = useTheme();
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent, isPending: saving } = useNostrPublish();
  const queryClient = useQueryClient();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const [justApplied, setJustApplied] = useState(false);
  const [saved, setSaved] = useState(false);
  const { naddr, copied, copy } = useNaddrLink(event);

  const tokens = useMemo(() => (theme ? coreToTokens(theme.colors) : null), [theme]);

  if (!theme || !tokens) return null;

  const isActive =
    mode === "custom" &&
    !!customTheme &&
    JSON.stringify(customTheme.colors) === JSON.stringify(theme.colors);

  const onApply = () => {
    applyCustomTheme({ title: theme.title, colors: theme.colors });
    setJustApplied(true);
  };

  const onSave = async () => {
    try {
      await publishEvent(buildThemeDefinitionEvent(theme.title, theme.colors));
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["user-themes"] });
      toast({ title: "Saved to your themes", description: theme.title });
    } catch (e) {
      toast({
        title: "Couldn't save theme",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  const applied = isActive || justApplied;

  return (
    <div
      className={cn(
        "flex flex-col w-full rounded-xl border border-border/60 bg-card overflow-hidden",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Live color preview */}
      <div
        className="flex items-end gap-1.5 p-3 h-20"
        style={{ backgroundColor: `hsl(${tokens.background})` }}
      >
        <span className="size-6 rounded-full" style={{ backgroundColor: `hsl(${tokens.primary})` }} />
        <span className="size-6 rounded-full" style={{ backgroundColor: `hsl(${tokens.secondary})` }} />
        <span className="flex-1 h-2 rounded-full" style={{ backgroundColor: `hsl(${tokens.muted})` }} />
        <span
          className="clip-corner-lg px-2 py-1 text-xs font-medium"
          style={{ backgroundColor: `hsl(${tokens.primary})`, color: `hsl(${tokens.primaryForeground})` }}
        >
          Aa
        </span>
      </div>

      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Palette className="size-4 shrink-0 text-primary" />
          {naddr ? (
            <Link
              to={naddrPath(naddr)}
              className="font-semibold truncate leading-tight flex-1 hover:underline"
            >
              {theme.title}
            </Link>
          ) : (
            <p className="font-semibold truncate leading-tight flex-1">{theme.title}</p>
          )}
          {/* What this card is at a glance — in chat it sits among link and
              event cards, as the emoji pack card's pill does. */}
          <span
            className={cn(
              "text-[10px] px-1.5 py-px rounded-full shrink-0",
              applied ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
            )}
          >
            {applied ? "Applied" : "Theme"}
          </span>
        </div>

        {theme.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 -mt-1">{theme.description}</p>
        )}

        <ProfilePreviewCard pubkey={event.pubkey}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
          >
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-[8px]">
                {displayName[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">
              by <DisplayName pubkey={event.pubkey} name={displayName} />
            </span>
          </button>
        </ProfilePreviewCard>

        <div className="mt-auto flex items-center gap-2">
          {applied ? (
            <Button variant="secondary" className="flex-1 clip-corner-lg" disabled>
              <Check className="size-4" />
              Applied
            </Button>
          ) : (
            <Button className="flex-1 clip-corner-lg" onClick={onApply}>
              <Palette className="size-4" />
              Apply
            </Button>
          )}
          {user && (
            <Button
              variant="secondary"
              className="shrink-0 clip-corner-lg"
              onClick={onSave}
              disabled={saving || saved}
              aria-label="Save to my themes"
              title="Save to my themes"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saved ? (
                <Check className="size-4" />
              ) : (
                <BookmarkPlus className="size-4" />
              )}
            </Button>
          )}
          {naddr && (
            <Button
              variant="secondary"
              className="shrink-0 clip-corner-lg"
              onClick={copy}
              aria-label="Copy theme link"
              title="Copy theme link"
            >
              {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

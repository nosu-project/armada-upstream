import { Check, Palette } from "lucide-react";
import { useMemo, useState } from "react";

import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useTheme } from "@/hooks/useTheme";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { parseDittoTheme } from "@/lib/themeEvent";
import { cn } from "@/lib/utils";
import { coreToTokens } from "@/themes";

import type { NostrEvent } from "@nostrify/nostrify";

interface ThemeDiscoverCardProps {
  /** A kind-36767 theme definition event. */
  event: NostrEvent;
  className?: string;
}

/**
 * A shareable theme (kind 36767) rendered as a discover card: a live preview of
 * its 3 core colors, the author, and an Apply button that sets it as the app's
 * custom theme (local — applying a theme publishes nothing).
 */
export function ThemeDiscoverCard({ event, className }: ThemeDiscoverCardProps) {
  const theme = useMemo(() => parseDittoTheme(event), [event]);
  const { customTheme, theme: mode, applyCustomTheme } = useTheme();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);
  const [justApplied, setJustApplied] = useState(false);

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

  const applied = isActive || justApplied;

  return (
    <div
      className={cn(
        "block w-full rounded-2xl border border-border bg-secondary/30 overflow-hidden",
        className,
      )}
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

      <div className="px-3.5 py-3 space-y-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Palette className="size-4 shrink-0 text-primary" />
          <p className="font-semibold truncate leading-tight flex-1">{theme.title}</p>
        </div>

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
            <span className="truncate">by {displayName}</span>
          </button>
        </ProfilePreviewCard>

        {applied ? (
          <Button variant="secondary" className="w-full clip-corner-lg" disabled>
            <Check className="size-4" />
            Applied
          </Button>
        ) : (
          <Button className="w-full clip-corner-lg" onClick={onApply}>
            <Palette className="size-4" />
            Apply theme
          </Button>
        )}
      </div>
    </div>
  );
}

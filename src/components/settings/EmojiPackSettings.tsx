import { Loader2, Smile, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { FallbackImage } from "@/components/ui/FallbackImage";
import {
  emojiPackEntries,
  emojiPackName,
  emojiPackPicture,
  useMyEmojiPacks,
  useRemoveEmojiPack,
  type MyEmojiPack,
} from "@/hooks/useEmojiPacks";
import { toast } from "@/hooks/useToast";

const packIconPlaceholder = (
  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-primary">
    <Smile className="size-4" />
  </span>
);

const PREVIEW_LIMIT = 8;

/** Emoji packs in the user's kind-10030 list, each removable. */
export function EmojiPackSettings() {
  const { data, isLoading, isError } = useMyEmojiPacks();

  if (isLoading && !data) {
    return (
      <SettingsRow>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading your emoji packs…
        </div>
      </SettingsRow>
    );
  }

  if (isError) {
    return (
      <SettingsRow>
        <p className="text-sm text-muted-foreground">
          Couldn't read your emoji list. Check your connection and try again.
        </p>
      </SettingsRow>
    );
  }

  if (!data || data.length === 0) {
    return (
      <SettingsRow>
        <p className="text-sm text-muted-foreground">
          No emoji packs added yet. Browse and add packs in{" "}
          <Link to="/discover" className="text-primary hover:underline">
            Discover
          </Link>
          .
        </p>
      </SettingsRow>
    );
  }

  return (
    <>
      {data.map((pack) => (
        <PackRow key={pack.coord} pack={pack} />
      ))}
    </>
  );
}

function PackRow({ pack }: { pack: MyEmojiPack }) {
  const { mutateAsync: removePack, isPending } = useRemoveEmojiPack();
  const [removed, setRemoved] = useState(false);

  const name = pack.event ? emojiPackName(pack.event) : pack.coord.split(":")[2] || "Emoji pack";
  const picture = pack.event ? emojiPackPicture(pack.event) : undefined;
  const entries = pack.event ? emojiPackEntries(pack.event) : [];
  const visible = entries.slice(0, PREVIEW_LIMIT);
  const extra = entries.length - visible.length;

  // Avoid a flash before the query invalidation removes it.
  if (removed) return null;

  const onRemove = async () => {
    try {
      await removePack({ coord: pack.coord });
      setRemoved(true);
      toast({ title: "Emoji pack removed", description: name });
    } catch (e) {
      toast({
        title: "Couldn't remove pack",
        description: e instanceof Error ? e.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  return (
    <SettingsRow>
      <div className="flex items-center gap-3">
        {picture ? (
          <FallbackImage
            src={picture}
            className="size-8 shrink-0 rounded-md object-cover border border-border/60"
            fallback={packIconPlaceholder}
          />
        ) : (
          packIconPlaceholder
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium leading-tight truncate">{name}</div>
          {visible.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              {visible.map((e) => (
                <CustomEmojiImg
                  key={e.shortcode}
                  name={e.shortcode}
                  url={e.url}
                  className="h-5 w-5 object-contain"
                />
              ))}
              {extra > 0 && (
                <span className="text-xs text-muted-foreground">+{extra}</span>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {pack.event ? "This pack has no emojis." : "Pack details couldn't be loaded."}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 touch:size-11 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          disabled={isPending}
          aria-label={`Remove ${name}`}
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </div>
    </SettingsRow>
  );
}

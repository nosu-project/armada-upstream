import { Loader2, Pencil, Plus, Smile, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { FallbackImage } from "@/components/ui/FallbackImage";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  emojiPackEntries,
  emojiPackName,
  emojiPackPicture,
  useMyEmojiPacks,
  useMyPublishedPacks,
  useRemoveEmojiPack,
  type MyEmojiPack,
} from "@/hooks/useEmojiPacks";
import { toast } from "@/hooks/useToast";

import type { NostrRumor } from "@/lib/nostrRumor";

const EmojiPackDialog = lazy(() =>
  import("@/components/discover/EmojiPackDialog").then((m) => ({ default: m.EmojiPackDialog })),
);

const packIconPlaceholder = (
  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-primary">
    <Smile className="size-4" />
  </span>
);

const PREVIEW_LIMIT = 8;

/**
 * The user's emoji packs: ones they published (editable) and ones they added from others
 * (kind-10030 `a` refs, removable). An own pack that is also on the list is shown once,
 * under Published, and can be removed from there.
 */
export function EmojiPackSettings() {
  const { user } = useCurrentUser();
  const published = useMyPublishedPacks();
  const added = useMyEmojiPacks();
  const [dialog, setDialog] = useState<{ edit?: NostrRumor } | null>(null);

  const loading = (published.isLoading && !published.data) || (added.isLoading && !added.data);
  const publishedPacks = published.data ?? [];
  const addedCoords = new Set((added.data ?? []).map((p) => p.coord));
  const addedFromOthers = (added.data ?? []).filter((p) => p.coord.split(":")[1] !== user?.pubkey);

  let body;
  if (loading) {
    body = (
      <SettingsRow>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading your emoji packs…
        </div>
      </SettingsRow>
    );
  } else {
    body = (
      <>
        {publishedPacks.length > 0 && (
          <>
            <GroupLabel title="Published" count={publishedPacks.length} />
            {publishedPacks.map((pack) => (
              <PackRow
                key={pack.coord}
                pack={pack}
                removable={addedCoords.has(pack.coord)}
                onEdit={(edit) => setDialog({ edit })}
              />
            ))}
          </>
        )}
        {addedFromOthers.length > 0 && (
          <>
            <GroupLabel title="Added" count={addedFromOthers.length} />
            {addedFromOthers.map((pack) => (
              <PackRow key={pack.coord} pack={pack} removable />
            ))}
          </>
        )}
        {added.isError ? (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">
              Couldn't read your emoji list. Check your connection and try again.
            </p>
          </SettingsRow>
        ) : publishedPacks.length === 0 && addedFromOthers.length === 0 && (
          <SettingsRow>
            <p className="text-sm text-muted-foreground">
              No emoji packs yet. Browse and add packs in{" "}
              <Link to="/discover?tab=emojis" className="text-primary hover:underline">
                Discover
              </Link>
              , or create your own.
            </p>
          </SettingsRow>
        )}
      </>
    );
  }

  return (
    <>
      {body}
      <SettingsRow>
        <Button
          variant="secondary"
          className="w-full clip-corner-lg"
          onClick={() => setDialog({})}
        >
          <Plus className="size-4" />
          Create emoji pack
        </Button>
      </SettingsRow>

      {dialog && (
        <Suspense fallback={null}>
          <EmojiPackDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            editEvent={dialog.edit}
          />
        </Suspense>
      )}
    </>
  );
}

function GroupLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      <span className="text-[11px] tabular-nums text-muted-foreground/70">{count}</span>
    </div>
  );
}

function PackRow({
  pack,
  removable,
  onEdit,
}: {
  pack: MyEmojiPack;
  /** On the user's 10030 list, so it can be taken off it. */
  removable: boolean;
  onEdit?: (event: NostrRumor) => void;
}) {
  const { mutateAsync: removePack, isPending } = useRemoveEmojiPack();
  const [removed, setRemoved] = useState(false);

  const name = pack.event ? emojiPackName(pack.event) : pack.coord.split(":")[2] || "Emoji pack";
  const picture = pack.event ? emojiPackPicture(pack.event) : undefined;
  const entries = pack.event ? emojiPackEntries(pack.event) : [];
  const visible = entries.slice(0, PREVIEW_LIMIT);
  const extra = entries.length - visible.length;

  // Avoid a flash before the query invalidation removes it. An own pack stays listed
  // (it is still published); it just loses its remove action.
  if (removed && !onEdit) return null;

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
        {onEdit && (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => pack.event && onEdit(pack.event)}
            disabled={!pack.event}
            aria-label={`Edit ${name}`}
          >
            <Pencil className="size-4" />
          </Button>
        )}
        {removable && !removed && (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 touch:size-11 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            disabled={isPending}
            aria-label={onEdit ? `Remove ${name} from your emojis` : `Remove ${name}`}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}

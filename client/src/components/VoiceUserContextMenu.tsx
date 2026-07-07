import { Copy, Volume2, VolumeX } from "lucide-react";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Slider } from "@/components/ui/slider";
import { toast } from "@/hooks/useToast";
import { useUserVolume } from "@/hooks/useUserVolume";
import { writeClipboardText } from "@/lib/clipboard";
import { tryNpubEncode } from "@/lib/safeNip19";

/**
 * The mute-toggle + 0–200% volume slider row used inside voice user menus
 * (the call-stage nameplate dropdown and the right-click context menu).
 */
export function VolumeSliderRow({
  volume,
  apply,
  displayName,
}: {
  volume: number;
  apply: (next: number) => void;
  displayName: string;
}) {
  const muted = volume === 0;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={muted ? "Unmute user" : "Mute user"}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => apply(muted ? 1 : 0)}
      >
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      <Slider
        value={[volume]}
        min={0}
        max={2}
        step={0.05}
        aria-label={`Volume for ${displayName}`}
        onValueChange={([v]) => apply(v)}
      />
    </div>
  );
}

/**
 * Right-click menu for a user in a voice call: per-user volume slider, local
 * mute toggle, and copy npub. Volume state lives in the shared per-pubkey
 * store (`useUserVolume`), so the connected room applies changes live and
 * every other control for the same user stays in sync. Used on the call-stage
 * tiles and the sidebar's nested voice roster. Set `showVolume={false}` for
 * the local user (there's no local playback of your own audio to adjust).
 */
export function VoiceUserContextMenu({
  pubkey,
  displayName,
  showVolume = true,
  children,
}: {
  pubkey: string;
  displayName: string;
  showVolume?: boolean;
  children: React.ReactNode;
}) {
  const [volume, setVolume] = useUserVolume(pubkey);
  const muted = volume === 0;
  const pct = Math.round(volume * 100);

  const copyNpub = () => {
    const npub = tryNpubEncode(pubkey);
    if (!npub) return;
    writeClipboardText(npub).then(
      () => toast({ title: "Copied npub" }),
      () => toast({ title: "Copy failed", variant: "destructive" }),
    );
  };

  return (
    <ContextMenu>
      {/* Stop propagation: in the channel sidebar the roster rows sit inside
          the channel row's own right-click menu trigger, and Radix triggers
          don't stop the event — without this both menus would open. */}
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="flex items-center justify-between gap-2">
          <span className="truncate">{displayName}</span>
          {showVolume && (
            <span className="text-xs text-muted-foreground tabular-nums font-normal">{pct}%</span>
          )}
        </ContextMenuLabel>
        {showVolume && (
          <>
            {/* Not a menu Item: the slider needs pointer drags, which Radix
                item semantics would swallow. */}
            <div className="px-2 pb-2 pt-1">
              <VolumeSliderRow volume={volume} apply={setVolume} displayName={displayName} />
            </div>
            <ContextMenuSeparator />
            <ContextMenuCheckboxItem checked={muted} onSelect={() => setVolume(muted ? 1 : 0)}>
              Mute
            </ContextMenuCheckboxItem>
          </>
        )}
        <ContextMenuItem className="gap-2" onSelect={copyNpub}>
          <Copy className="size-4" />
          Copy npub
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

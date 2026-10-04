import { Copy, MoreVertical, UserCheck, UserX, Volume2, VolumeX } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { useMuteToggle } from "@/hooks/useMuteList";
import { toast } from "@/hooks/useToast";
import { useScreenShareVolume, useUserVolume } from "@/hooks/useUserVolume";
import { writeClipboardText } from "@/lib/clipboard";
import { tryNpubEncode } from "@/lib/safeNip19";
import { cn } from "@/lib/utils";
import { MAX_PLAYBACK_VOLUME } from "@/lib/voiceDevices";

export type PlaybackVolumeTarget = "user" | "screenShare";

export function VolumeSliderRow({
  volume,
  apply,
  displayName,
  target = "user",
}: {
  volume: number;
  apply: (next: number) => void;
  displayName: string;
  target?: PlaybackVolumeTarget;
}) {
  const muted = volume === 0;
  const targetLabel = target === "screenShare" ? "screen share" : "user";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={muted ? `Unmute ${targetLabel}` : `Mute ${targetLabel}`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => apply(muted ? 1 : 0)}
      >
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      <Slider
        value={[volume]}
        min={0}
        max={MAX_PLAYBACK_VOLUME}
        step={0.05}
        aria-label={target === "screenShare"
          ? `Screen share volume for ${displayName}`
          : `Volume for ${displayName}`}
        aria-valuetext={`${Math.round(volume * 100)}%`}
        onValueChange={([v]) => apply(v)}
      />
    </div>
  );
}

/**
 * Shared voice-user menu body (volume, local mute, copy npub) for both
 * context and dropdown menus. `showVolume={false}` for the local user.
 */
function useVoiceMenuItems(
  pubkey: string,
  displayName: string,
  showVolume: boolean,
  verified: boolean,
  volumeTarget: PlaybackVolumeTarget,
) {
  const mute = useMuteToggle(pubkey);
  const [userVolume, setUserVolume] = useUserVolume(pubkey);
  const [screenShareVolume, setScreenShareVolume] = useScreenShareVolume(pubkey);
  const volume = volumeTarget === "screenShare" ? screenShareVolume : userVolume;
  const setVolume = volumeTarget === "screenShare" ? setScreenShareVolume : setUserVolume;
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

  return function renderMenuItems({
    Item,
    CheckboxItem,
    Label,
    Separator,
  }: {
    Item: typeof ContextMenuItem | typeof DropdownMenuItem;
    CheckboxItem: typeof ContextMenuCheckboxItem | typeof DropdownMenuCheckboxItem;
    Label: typeof ContextMenuLabel | typeof DropdownMenuLabel;
    Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
  }) {
    return (
      <>
        <Label className="flex items-center justify-between gap-2">
          <span className="truncate">
            <DisplayName pubkey={verified ? pubkey : undefined} name={displayName} />
            {volumeTarget === "screenShare" && "'s screen share"}
          </span>
          {showVolume && (
            <span className="text-xs text-muted-foreground tabular-nums font-normal">{pct}%</span>
          )}
        </Label>
        {showVolume && (
          <>
            {/* Not a menu Item: Radix item semantics would swallow slider drags. */}
            <div className="px-2 pb-2 pt-1">
              <VolumeSliderRow
                volume={volume}
                apply={setVolume}
                displayName={displayName}
                target={volumeTarget}
              />
            </div>
            <Separator />
            <CheckboxItem checked={muted} onSelect={() => setVolume(muted ? 1 : 0)}>
              {volumeTarget === "screenShare" ? "Mute screen share" : "Mute"}
            </CheckboxItem>
          </>
        )}
        <Item className="gap-2" onSelect={copyNpub}>
          <Copy className="size-4" />
          Copy npub
        </Item>
        {/* NIP-51 mute, only for VERIFIED pubkeys: muting an unclaimed identity would
            write someone else's pubkey to the list. */}
        {verified && mute.canMute && (
          <>
            <Separator />
            <Item
              className={cn(
                "gap-2",
                !mute.muted && "text-destructive focus:text-destructive",
              )}
              onSelect={() => void mute.toggle()}
            >
              {mute.muted ? <UserCheck className="size-4" /> : <UserX className="size-4" />}
              {mute.muted ? "Unblock person" : "Block person"}
            </Item>
          </>
        )}
      </>
    );
  };
}

/** Right-click voice user menu; pair with {@link VoiceUserMenuButton} for touch. */
export function VoiceUserContextMenu({
  pubkey,
  displayName,
  showVolume = true,
  verified = true,
  volumeTarget = "user",
  children,
}: {
  pubkey: string;
  displayName: string;
  showVolume?: boolean;
  volumeTarget?: PlaybackVolumeTarget;
  /** Unverified claims render the name as plain text so they can't borrow another profile's emoji. */
  verified?: boolean;
  children: React.ReactNode;
}) {
  const renderMenuItems = useVoiceMenuItems(
    pubkey,
    displayName,
    showVolume,
    verified,
    volumeTarget,
  );

  return (
    <ContextMenu>
      {/* Stop propagation, or the enclosing channel row's context menu opens too. */}
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {renderMenuItems({
          Item: ContextMenuItem,
          CheckboxItem: ContextMenuCheckboxItem,
          Label: ContextMenuLabel,
          Separator: ContextMenuSeparator,
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Tap-triggered "⋮" version of {@link VoiceUserContextMenu}. */
export function VoiceUserMenuButton({
  pubkey,
  displayName,
  showVolume = true,
  verified = true,
  volumeTarget = "user",
  className,
}: {
  pubkey: string;
  displayName: string;
  showVolume?: boolean;
  volumeTarget?: PlaybackVolumeTarget;
  verified?: boolean;
  className?: string;
}) {
  const renderMenuItems = useVoiceMenuItems(
    pubkey,
    displayName,
    showVolume,
    verified,
    volumeTarget,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${displayName}`}
          // Stop propagation, including the channel row's press-and-hold reorder.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          className={cn(
            "shrink-0 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/10 data-[state=open]:text-foreground",
            className,
          )}
        >
          <MoreVertical className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {renderMenuItems({
          Item: DropdownMenuItem,
          CheckboxItem: DropdownMenuCheckboxItem,
          Label: DropdownMenuLabel,
          Separator: DropdownMenuSeparator,
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

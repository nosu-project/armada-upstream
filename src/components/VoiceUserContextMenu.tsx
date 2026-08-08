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

/**
 * The mute-toggle + 0–200% volume slider row shared by voice-user and
 * screen-share menus.
 */
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
 * The shared body of a voice user's menu — source-specific volume slider,
 * local mute toggle, and copy npub — rendered via whichever primitive the
 * caller passes (context menu on right-click, dropdown menu on tap/click).
 * Keeping one render fn means both surfaces stay in lockstep, exactly like
 * MemberList's member menu. Volume state lives in the shared per-pubkey store,
 * so the connected room applies changes live and every other control for the
 * same user stays in sync. Set `showVolume={false}` for the local user (there's
 * no local playback of your own audio to adjust).
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
            {volumeTarget === "screenShare" && " — screen share"}
          </span>
          {showVolume && (
            <span className="text-xs text-muted-foreground tabular-nums font-normal">{pct}%</span>
          )}
        </Label>
        {showVolume && (
          <>
            {/* Not a menu Item: the slider needs pointer drags, which Radix
                item semantics would swallow. */}
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
        {/* The NIP-51 person mute, distinct from the local playback "Mute"
            above — hence the wording, which matches the rest of the app. Only
            offered for a VERIFIED pubkey: an unclaimed voice identity is a
            name we haven't tied to a key, so muting it would write someone
            else's pubkey to the user's list. */}
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
              {mute.muted ? "Unmute person" : "Mute person"}
            </Item>
          </>
        )}
      </>
    );
  };
}

/**
 * Right-click menu for a user in a voice call: per-user volume slider, local
 * mute toggle, and copy npub. Used on the call-stage tiles and the sidebar's
 * nested voice roster. On touch devices (where right-click / long-press is
 * unreliable and invisible), pair this with {@link VoiceUserMenuButton} so the
 * same actions are reachable by tapping a visible button.
 */
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
  /**
   * Whether `pubkey` is a claim we've verified — i.e. whether the name (and the
   * custom emoji in it) are really theirs. Unverified claims render the name as
   * plain text so an unclaimed identity can't borrow another profile's emoji.
   */
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
      {/* Stop propagation: in the channel sidebar the roster rows sit inside
          the channel row's own right-click menu trigger, and Radix triggers
          don't stop the event — without this both menus would open. */}
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

/**
 * A tap/click-triggered version of the voice user menu, rendered as a small
 * "⋮" button — the discoverable, touch-friendly path to per-user volume and
 * actions (right-click / long-press is invisible and unreliable on mobile).
 * Shares its body with {@link VoiceUserContextMenu} so both stay in sync.
 */
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
  /** See {@link VoiceUserContextMenu}. */
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
          // Stop propagation so opening the menu from a row nested in another
          // right-click/click surface doesn't also trigger that surface.
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

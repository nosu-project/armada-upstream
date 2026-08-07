import { DisconnectButton, useLocalParticipant } from "@livekit/components-react";
import {
  Hand,
  Loader2,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  RefreshCw,
  Smile,
  Video,
  VideoOff,
} from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCallSignals } from "@/contexts/CallSignalsContext";
import { useCall } from "@/hooks/useCall";
import { toast } from "@/hooks/useToast";
import { playLeaveSound, playMuteSound, playUnmuteSound } from "@/lib/callSounds";
import { usePushToTalkRuntime } from "@/lib/pushToTalk";
import { switchPublishedScreenShare } from "@/lib/screenShare";
import { cn } from "@/lib/utils";

/**
 * Shared in-call control buttons — the single styled source for the media
 * controls that appear in BOTH the call-control bar (the channel-list panel)
 * and the video pane (the floating PiP window + theater mode), so the two never
 * drift apart. Every button is a compact filled icon that reflects its live
 * state, and grows to a 44px touch target on real touch devices. All must
 * render inside a `LiveKitRoom` context (they read the local participant).
 */

/** Whether this browser can capture the screen (absent on most mobile). */
const supportsScreenShare =
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";

/** The shared icon-button frame: compact on pointer, 44px on touch. */
const CTRL = "inline-flex items-center justify-center rounded-md size-8 touch:size-11 shrink-0 transition-colors";

export function MicButton({ className }: { className?: string }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const pushToTalk = usePushToTalkRuntime();
  const label = pushToTalk.ready
    ? pushToTalk.pressed
      ? "Talking — release to mute"
      : `Hold ${pushToTalk.bindingLabel || "your shortcut"} to talk`
    : isMicrophoneEnabled
      ? "Mute microphone"
      : "Unmute microphone";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={pushToTalk.ready}
      onClick={() => {
        if (pushToTalk.ready) return;
        const enabling = !isMicrophoneEnabled;
        // Self-only feedback, on the click gesture (AudioContext unlocked).
        if (enabling) playUnmuteSound();
        else playMuteSound();
        void localParticipant.setMicrophoneEnabled(enabling);
      }}
      className={cn(
        CTRL,
        isMicrophoneEnabled
          ? "bg-foreground/10 text-foreground hover:bg-foreground/20"
          : "bg-destructive/20 text-destructive hover:bg-destructive/30",
        pushToTalk.ready && "cursor-default disabled:opacity-100",
        className,
      )}
    >
      {isMicrophoneEnabled ? <Mic className="size-4" /> : <MicOff className="size-4" />}
    </button>
  );
}

export function CameraButton({ className }: { className?: string }) {
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const label = isCameraEnabled ? "Turn off camera" : "Turn on camera";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void localParticipant
          .setCameraEnabled(!isCameraEnabled)
          .catch((err) => console.warn("failed to toggle camera", err));
      }}
      className={cn(
        CTRL,
        isCameraEnabled
          ? "bg-foreground/10 text-foreground hover:bg-foreground/20"
          : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
        className,
      )}
    >
      {isCameraEnabled ? <Video className="size-4" /> : <VideoOff className="size-4" />}
    </button>
  );
}

export function ScreenShareButton({ className }: { className?: string }) {
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const [switching, setSwitching] = useState(false);
  if (!supportsScreenShare) return null;

  const startShare = () => {
    void localParticipant
      .setScreenShareEnabled(true, { audio: true })
      .catch((err) => {
        if (err instanceof Error && err.name === "NotAllowedError") return;
        console.warn("failed to start screen share", err);
      });
  };
  const stopShare = () => {
    void localParticipant
      .setScreenShareEnabled(false, { audio: true })
      .catch((err) => console.warn("failed to stop screen share", err));
  };
  const switchShare = async () => {
    if (switching) return;
    setSwitching(true);
    try {
      await switchPublishedScreenShare(localParticipant);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") return;
      console.warn("failed to switch screen share", err);
      toast({
        title: "Couldn't switch the screen share",
        description: "Your existing share is still active. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSwitching(false);
    }
  };

  if (!isScreenShareEnabled) {
    return (
      <button
        type="button"
        aria-label="Share screen"
        title="Share screen"
        onClick={startShare}
        className={cn(
          CTRL,
          "bg-foreground/5 text-muted-foreground hover:bg-foreground/10",
          className,
        )}
      >
        <MonitorUp className="size-4" />
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Screen share options"
          title="Screen share options"
          disabled={switching}
          className={cn(
            CTRL,
            "bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-60",
            className,
          )}
        >
          {switching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MonitorUp className="size-4" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => void switchShare()}>
          <RefreshCw className="size-4" />
          Switch screen or audio
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={stopShare}
        >
          <MonitorOff className="size-4" />
          Stop sharing
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LeaveButton({ className }: { className?: string }) {
  const { leaveCall } = useCall();
  return (
    <DisconnectButton
      // Play the leave chirp inside the gesture, before the disconnect tears
      // down the room audio. `leaveCall` runs the exit animation + teardown;
      // DisconnectButton also disconnects. Both are idempotent.
      onClick={() => {
        playLeaveSound();
        leaveCall();
      }}
      aria-label="Leave call"
      title="Leave call"
      className={cn(CTRL, "bg-destructive text-destructive-foreground hover:bg-destructive/90", className)}
    >
      <PhoneOff className="size-4" />
    </DisconnectButton>
  );
}

/**
 * Raise / lower your hand — a distinct toggle (Armada client feature; Concord
 * calls only). Renders nothing where the feature is unavailable. Sits beside
 * {@link ReactionsMenu} in the video pane.
 */
export function RaiseHandButton({ className }: { className?: string }) {
  const { enabled, myHandRaised, toggleHand } = useCallSignals();
  if (!enabled) return null;
  const label = myHandRaised ? "Lower hand" : "Raise hand";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={myHandRaised}
      onClick={toggleHand}
      className={cn(
        CTRL,
        myHandRaised
          ? "bg-amber-500/25 text-amber-500 hover:bg-amber-500/35"
          : "bg-foreground/10 text-foreground hover:bg-foreground/20",
        className,
      )}
    >
      <Hand className="size-4" />
    </button>
  );
}

/**
 * The quick emoji tray, à la Zoom/Signal in-call reactions. A small fixed set —
 * a floating burst is a glance, not a message (and reactions ride a
 * size-bounded presence tag; see voice.ts).
 */
const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "👏"] as const;

/**
 * The emoji-reaction tray button (Concord calls only). Renders nothing where
 * the feature is unavailable. Pairs with {@link RaiseHandButton}.
 */
export function ReactionsMenu({ className }: { className?: string }) {
  const { enabled, sendReaction } = useCallSignals();
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Reactions"
          title="Reactions"
          className={cn(CTRL, "bg-foreground/10 text-foreground hover:bg-foreground/20", className)}
        >
          <Smile className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto p-2">
        <div className="grid grid-cols-4 gap-1">
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => {
                sendReaction(emoji);
                setOpen(false);
              }}
              className="flex size-10 touch:size-12 items-center justify-center rounded-md font-emoji text-2xl leading-none hover:bg-foreground/10 active:scale-95 transition-transform"
            >
              {emoji}
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

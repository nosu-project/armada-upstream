import { DisconnectButton, useLocalParticipant, useRoomContext } from "@livekit/components-react";
import {
  Hand,
  Info,
  Loader2,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  PhoneOff,
  RefreshCw,
  Settings2,
  Smile,
  Video,
  VideoOff,
  VolumeX,
} from "lucide-react";
import { Track } from "livekit-client";
import { useEffect, useState } from "react";

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
import { ToastAction } from "@/components/ui/toast";
import { playLeaveSound, playMuteSound, playUnmuteSound } from "@/lib/callSounds";
import { requestPushToTalkOverride, usePushToTalkRuntime } from "@/lib/pushToTalk";
import {
  applyPublishedScreenShareQuality,
  installScreenShareCodecPreferences,
  isScreenShareAudioSourceFailure,
  isScreenShareSwitchPartialFailure,
  switchPublishedScreenShare,
} from "@/lib/screenShare";
import {
  formatScreenShareQuality,
  getScreenShareQuality,
  normalizeScreenShareQuality,
  rememberScreenShareQuality,
  screenShareCaptureOptions,
  screenShareDisplayMediaOptions,
  screenSharePublishOptions,
  type ScreenShareQuality,
} from "@/lib/screenShareQuality";
import { consumeOwnAudioDrop, describeOwnAudioDrop } from "@/lib/screenShareOwnAudio";
import { cn } from "@/lib/utils";
import { ScreenShareQualityDialog } from "@/components/chat/ScreenShareQualityDialog";
import { ScreenShareDiagnosticsDialog } from "@/components/chat/ScreenShareDiagnosticsDialog";
import {
  desktopScreenCaptureAccessStatus,
  openDesktopScreenCaptureSettings,
} from "@/lib/desktop";

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
  const room = useRoomContext();
  const pushToTalk = usePushToTalkRuntime();
  const label = pushToTalk.ready
    ? pushToTalk.pressed
      ? "Talking — click to mute and stop push to talk"
      : `Hold ${pushToTalk.bindingLabel || "your shortcut"} to talk`
    : isMicrophoneEnabled
      ? "Mute microphone"
      : "Unmute microphone";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        // While push to talk owns the microphone this button is the override,
        // not a toggle: a global shortcut can lose its key-up (another window
        // grabs the keyboard, the machine sleeps mid-press), and disabling the
        // button would leave the user transmitting with no way back.
        if (pushToTalk.ready) {
          playMuteSound();
          requestPushToTalkOverride();
          void localParticipant.setMicrophoneEnabled(false);
          return;
        }
        const enabling = !isMicrophoneEnabled;
        // Self-only feedback, on the click gesture (AudioContext unlocked).
        if (enabling) playUnmuteSound();
        else playMuteSound();
        void (async () => {
          try {
            // `webAudioMix` plays remote audio through a Web Audio graph that
            // starts suspended until a user gesture unlocks it; without this the
            // mic can toggle while you hear nobody. Runs on the click gesture.
            if (enabling && room && !room.canPlaybackAudio) {
              await room.startAudio();
            }
            await localParticipant.setMicrophoneEnabled(enabling);
          } catch (err) {
            console.warn("failed to toggle microphone", err);
            // A silently-swallowed unmute rejection is the reported "can't
            // unmute" bug: retry once, then surface it instead of leaving the
            // button showing muted with no explanation.
            if (!enabling) return;
            try {
              await localParticipant.setMicrophoneEnabled(true);
            } catch (retryErr) {
              toast({
                title: "Couldn't unmute",
                description:
                  retryErr instanceof Error ? retryErr.message : "The microphone is unavailable.",
                variant: "destructive",
              });
            }
          }
        })();
      }}
      className={cn(
        CTRL,
        isMicrophoneEnabled
          ? "bg-foreground/10 text-foreground hover:bg-foreground/20"
          : "bg-destructive/20 text-destructive hover:bg-destructive/30",
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

export function ScreenShareButton({
  className,
  portalContainer,
}: {
  className?: string;
  portalContainer?: HTMLElement;
}) {
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const { enabled: endToEndEncrypted, hevcScreenShare } = useCallSignals();
  const [qualityOpen, setQualityOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const customHevcAvailable = Boolean(hevcScreenShare?.capability?.available);
  const customHevcActive = Boolean(hevcScreenShare?.active);
  const shareActive = isScreenShareEnabled || customHevcActive;
  const screenSharePublication = localParticipant.getTrackPublication(Track.Source.ScreenShare);
  // A share that is publishing video but no audio track is silent — the state
  // the audio-source failure used to leave behind invisibly. Surface it so a
  // muted share is never a surprise. Scoped to the standard LiveKit path; the
  // custom H.265 publisher carries its audio separately.
  const screenShareAudioMissing =
    isScreenShareEnabled &&
    !customHevcActive &&
    !localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  useEffect(
    () => installScreenShareCodecPreferences(localParticipant, { endToEndEncrypted }),
    [endToEndEncrypted, localParticipant],
  );
  if (!supportsScreenShare) return null;

  const handleCapturePermission = async (error: unknown): Promise<boolean> => {
    if (!(error instanceof Error) || error.name !== "NotAllowedError") return false;
    // A cancelled picker and a platform denial are the same DOMException
    // outside macOS, so this stays silent — but never unlogged, or a denied
    // xdg-desktop-portal request leaves no trace anywhere.
    console.warn("screen capture was not permitted", error);
    const status = await desktopScreenCaptureAccessStatus();
    if (status === "denied" || status === "restricted") {
      toast({
        title: "Screen Recording permission required",
        description: "Allow Armada in macOS Privacy & Security, then try sharing again.",
        variant: "destructive",
        action: (
          <ToastAction
            altText="Open Screen Recording settings"
            onClick={() => void openDesktopScreenCaptureSettings()}
          >
            Settings
          </ToastAction>
        ),
      });
    }
    // A normal picker cancellation is also NotAllowedError and stays silent.
    return true;
  };

  const acquireCustomHevc = async (quality: ScreenShareQuality): Promise<MediaStream> => {
    if (!hevcScreenShare || !customHevcAvailable) {
      throw new Error(
        hevcScreenShare?.capability?.reason || "The Linux H.265 encoder is unavailable.",
      );
    }
    // This goes through the same trusted desktop picker/audio wrapper as the
    // regular LiveKit path; only encoding and publication diverge afterward.
    return navigator.mediaDevices.getDisplayMedia(screenShareDisplayMediaOptions(quality));
  };

  const applyQuality = (
    value: ScreenShareQuality,
    options?: { rememberAs?: ScreenShareQuality },
  ) => {
    if (working) return;
    setWorking(true);
    const quality = normalizeScreenShareQuality({
      ...value,
      ...(value.codec === "h265" && customHevcAvailable ? { delivery: "full" as const } : {}),
    });
    void (async () => {
      if (quality.codec === "h265" && customHevcAvailable) {
        const stream = await acquireCustomHevc(quality);
        // Bring up the replacement before retiring LiveKit's standard share.
        // A failed normal→custom transition therefore leaves the old share
        // running instead of stranding the presenter with a false success.
        await hevcScreenShare!.start(stream, quality);
        if (isScreenShareEnabled) {
          try {
            await localParticipant.setScreenShareEnabled(false, { audio: true });
          } catch (error) {
            try {
              await hevcScreenShare!.stop();
            } catch {
              // The truthful transition error below is more useful; the shell
              // also tears its publisher down when the capture stream ends.
            }
            throw new Error(
              `The H.265 sender started, but the previous share could not be retired. The previous share remains active: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return;
      }
      if (customHevcActive) {
        await localParticipant.setScreenShareEnabled(
          true,
          screenShareCaptureOptions(quality),
          screenSharePublishOptions(quality),
        );
        await hevcScreenShare?.stop();
        return;
      }
      if (!isScreenShareEnabled) {
        await localParticipant.setScreenShareEnabled(
          true,
          screenShareCaptureOptions(quality),
          screenSharePublishOptions(quality),
        );
        return;
      }
      await applyPublishedScreenShareQuality(localParticipant, quality);
    })()
      .then(() => {
        // `rememberAs` lets the audio-off recovery below capture this ONE
        // surface without audio while persisting the user's real preference
        // unchanged. Without it, one window with no openable loopback endpoint
        // would write `captureAudio: false` globally and silently mute every
        // later share — a different window, or the entire screen — until the
        // user found the buried toggle. The persisted preference is not scoped
        // to a surface, so a per-surface failure must never rewrite it.
        rememberScreenShareQuality(options?.rememberAs ?? quality);
        // A capture whose audio could not be confirmed free of the call's own
        // playback goes out without it (screenShareOwnAudio.ts). Say so — a
        // silent share is exactly the surprise this exists to prevent.
        const dropped = consumeOwnAudioDrop();
        if (dropped) {
          toast({ title: "Sharing without audio", description: describeOwnAudioDrop(dropped) });
        } else if (shareActive) {
          toast({
            title: "Screen share quality updated",
            description: formatScreenShareQuality(quality),
          });
        }
      })
      .catch(async (error) => {
        // A failed apply must not explain a later success.
        consumeOwnAudioDrop();
        if (await handleCapturePermission(error)) return;
        console.warn("failed to update screen share quality", error);
        // Windows/Chromium fails the WHOLE capture when it cannot open the
        // surface's audio endpoint. Offer the one action that recovers it —
        // retry with audio off — rather than a dead "try again" that would
        // hit the same wall. Only when audio was actually requested.
        if (quality.captureAudio && isScreenShareAudioSourceFailure(error)) {
          toast({
            title: "Couldn't share screen audio",
            description:
              "This screen or window has no audio Armada can capture. Share without audio instead?",
            variant: "destructive",
            action: (
              <ToastAction
                altText="Share without audio"
                onClick={() =>
                  applyQuality({ ...quality, captureAudio: false }, { rememberAs: quality })
                }
              >
                Share without audio
              </ToastAction>
            ),
          });
          return;
        }
        toast({
          title: "Couldn't update screen share quality",
          description:
            error instanceof Error ? error.message : "The new quality could not be applied.",
          variant: "destructive",
        });
      })
      .finally(() => setWorking(false));
  };
  const stopShare = () => {
    if (customHevcActive) {
      void hevcScreenShare?.stop().catch((error) =>
        console.warn("failed to stop H.265 screen share", error),
      );
    } else {
      void localParticipant
        .setScreenShareEnabled(false, { audio: true })
        .catch((error) => console.warn("failed to stop screen share", error));
    }
  };
  const switchShare = async () => {
    if (working) return;
    setWorking(true);
    try {
      const quality = getScreenShareQuality();
      if (customHevcActive && hevcScreenShare) {
        const stream = await acquireCustomHevc(quality);
        await hevcScreenShare.start(stream, quality);
      } else {
        await switchPublishedScreenShare(localParticipant, quality);
      }
      const dropped = consumeOwnAudioDrop();
      if (dropped) {
        toast({ title: "Sharing without audio", description: describeOwnAudioDrop(dropped) });
      }
    } catch (error) {
      consumeOwnAudioDrop();
      if (await handleCapturePermission(error)) return;
      console.warn("failed to switch screen share", error);
      toast({
        title: "Couldn't switch the screen share",
        // The new source is already published once the video swap lands, so
        // only a swap that failed before that leaves the previous share up.
        description: customHevcActive || isScreenShareSwitchPartialFailure(error)
          ? error instanceof Error
            ? error.message
            : "The previous H.265 share stopped while the replacement was starting."
          : "Your existing share is still active. Please try again.",
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  if (!shareActive) {
    return (
      <>
        <button
          type="button"
          aria-label="Share screen"
          title="Share screen"
          disabled={working}
          onClick={() => setQualityOpen(true)}
          className={cn(
            CTRL,
            "bg-foreground/5 text-muted-foreground hover:bg-foreground/10 disabled:opacity-60",
            className,
          )}
        >
          {working ? <Loader2 className="size-4 animate-spin" /> : <MonitorUp className="size-4" />}
        </button>
        <ScreenShareQualityDialog
          open={qualityOpen}
          portalContainer={portalContainer}
          active={false}
          participant={localParticipant}
          endToEndEncrypted={endToEndEncrypted}
          customHevcAvailable={customHevcAvailable}
          nativeHevcStatus={hevcScreenShare?.status}
          onOpenChange={setQualityOpen}
          onConfirm={applyQuality}
        />
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={
              screenShareAudioMissing
                ? "Screen share options — audio is not being captured"
                : "Screen share options"
            }
            title={
              screenShareAudioMissing
                ? "Screen share options — audio is not being captured"
                : "Screen share options"
            }
            disabled={working}
            className={cn(
              CTRL,
              "relative bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-60",
              className,
            )}
          >
            {working ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MonitorUp className="size-4" />
            )}
            {screenShareAudioMissing && !working && (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-background text-destructive"
              >
                <VolumeX className="size-2.5" />
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56"
          portalContainer={portalContainer}
        >
          <DropdownMenuItem onSelect={() => setQualityOpen(true)}>
            <Settings2 className="size-4" />
            Screen share quality
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDetailsOpen(true)}>
            <Info className="size-4" />
            Stream details
          </DropdownMenuItem>
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
      <ScreenShareQualityDialog
        open={qualityOpen}
        portalContainer={portalContainer}
        active
        participant={localParticipant}
        endToEndEncrypted={endToEndEncrypted}
        customHevcAvailable={customHevcAvailable}
        nativeHevcStatus={hevcScreenShare?.status}
        onOpenChange={setQualityOpen}
        onConfirm={applyQuality}
      />
      <ScreenShareDiagnosticsDialog
        open={detailsOpen}
        portalContainer={portalContainer}
        track={screenSharePublication?.videoTrack}
        audioTrack={localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.audioTrack}
        encrypted={customHevcActive ? true : screenSharePublication?.isEncrypted}
        participantName="you"
        nativeHevcStatus={customHevcActive ? hevcScreenShare?.status : undefined}
        onOpenChange={setDetailsOpen}
      />
    </>
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
export function ReactionsMenu({
  className,
  portalContainer,
}: {
  className?: string;
  portalContainer?: HTMLElement;
}) {
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
      <DropdownMenuContent
        align="end"
        className="w-auto p-2"
        portalContainer={portalContainer}
      >
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

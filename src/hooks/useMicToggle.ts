import { useLocalParticipant, useRoomContext } from "@livekit/components-react";

import { toast } from "@/hooks/useToast";
import { playMuteSound, playUnmuteSound } from "@/lib/callSounds";
import { requestPushToTalkOverride, usePushToTalkRuntime } from "@/lib/pushToTalk";

/** The mic toggle shared by the in-call button and the Android call notification. */
export function useMicToggle() {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const pushToTalk = usePushToTalkRuntime();
  const toggle = () => {
    // Under push to talk this is an override, not a toggle: a global shortcut can
    // lose its key-up, so disabling it could leave the user stuck transmitting.
    if (pushToTalk.ready) {
      playMuteSound();
      requestPushToTalkOverride();
      void localParticipant.setMicrophoneEnabled(false);
      return;
    }
    const enabling = !isMicrophoneEnabled;
    // On the click gesture (AudioContext unlocked).
    if (enabling) playUnmuteSound();
    else playMuteSound();
    void (async () => {
      try {
        // `webAudioMix`'s graph starts suspended until a gesture unlocks it.
        if (enabling && room && !room.canPlaybackAudio) {
          await room.startAudio();
        }
        await localParticipant.setMicrophoneEnabled(enabling);
      } catch (err) {
        console.warn("failed to toggle microphone", err);
        // Don't swallow an unmute rejection silently: retry once, then surface it.
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
  };
  return { isMicrophoneEnabled, pushToTalk, toggle };
}

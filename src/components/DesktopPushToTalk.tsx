import { useLocalParticipant } from "@livekit/components-react";
import { useEffect } from "react";

import { isDesktop } from "@/lib/desktop";
import {
  configureDesktopPushToTalk,
  onDesktopPushToTalkState,
  onPushToTalkOverride,
  setDesktopPushToTalkActive,
  setPushToTalkRuntime,
  usePushToTalkPreferences,
} from "@/lib/pushToTalk";

/**
 * How many times a key-up mute is retried before giving up. Muting is the
 * safety-critical direction, but a track that refuses to close will keep
 * refusing; the call UI's override is the backstop past this.
 */
const MUTE_ATTEMPTS = 3;

/**
 * Owns push-to-talk for the connected LiveKit room. The Electron main process
 * watches the physical shortcut even while Armada is unfocused; this component
 * is the only place that turns those press/release events into microphone
 * publication changes.
 */
export function DesktopPushToTalk() {
  const { localParticipant } = useLocalParticipant();
  const preferences = usePushToTalkPreferences();

  useEffect(() => {
    if (!isDesktop() || !preferences.enabled) {
      setPushToTalkRuntime({ ready: false, pressed: false, bindingLabel: null });
      return;
    }

    let disposed = false;
    let overridden = false;
    let unsubscribe = () => {};
    let desired = false;
    let applied: boolean | null = null;
    let applying = false;

    // Serialize LiveKit toggles so a quick tap cannot leave the microphone on
    // if setMicrophoneEnabled(true) resolves after the key-up request.
    const applyDesired = async () => {
      if (applying) return;
      applying = true;
      let stalled = false;
      let muteFailures = 0;
      try {
        while (!disposed && !stalled && applied !== desired) {
          const next = desired;
          try {
            await localParticipant.setMicrophoneEnabled(next);
            applied = next;
            muteFailures = 0;
          } catch (error) {
            console.warn("push-to-talk microphone toggle failed", error);
            if (next) {
              // The unmute failed, so the track is still closed. Record that
              // truth and wait for the next key event: looping here would spin
              // for as long as the key is held.
              applied = false;
              stalled = true;
            } else if ((muteFailures += 1) >= MUTE_ATTEMPTS) {
              // Leave `applied` unknown so a later event tries again. Claiming
              // the mute succeeded is what leaves the microphone live while the
              // UI reports the shortcut released.
              applied = null;
              stalled = true;
            }
          }
        }
      } finally {
        applying = false;
        if (!disposed && !stalled && applied !== desired) void applyDesired();
      }
    };

    const setPressed = (pressed: boolean, bindingLabel: string) => {
      if (overridden) return;
      desired = pressed;
      setPushToTalkRuntime({ ready: true, pressed, bindingLabel });
      void applyDesired();
    };

    // The call UI's mic button stands push-to-talk down and closes the track,
    // for a press whose release never arrived.
    const unsubscribeOverride = onPushToTalkOverride(() => {
      overridden = true;
      desired = false;
      setPushToTalkRuntime({ ready: false, pressed: false, bindingLabel: null });
      void setDesktopPushToTalkActive(false);
      void applyDesired();
    });

    const start = async () => {
      const status = await configureDesktopPushToTalk(preferences.binding);
      if (disposed || overridden || !status.supported) return;
      const bindingLabel = status.bindingLabel || preferences.binding.label;
      // Subscribe and force mute before the main process starts forwarding
      // global events. This makes activation fail closed.
      unsubscribe = onDesktopPushToTalkState((pressed) => setPressed(pressed, bindingLabel));
      desired = false;
      await applyDesired();
      if (disposed) return;
      setPushToTalkRuntime({ ready: true, pressed: false, bindingLabel });
      await setDesktopPushToTalkActive(true);
    };
    void start();

    return () => {
      disposed = true;
      desired = false;
      unsubscribe();
      unsubscribeOverride();
      void setDesktopPushToTalkActive(false);
      // Always leave the old room muted when changing bindings or unmounting.
      void localParticipant.setMicrophoneEnabled(false).catch(() => {});
      setPushToTalkRuntime({ ready: false, pressed: false, bindingLabel: null });
    };
  }, [localParticipant, preferences.binding, preferences.enabled]);

  return null;
}

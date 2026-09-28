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

/** Key-up mute retries; the call UI's override is the backstop past this. */
const MUTE_ATTEMPTS = 3;

/** Turns the Electron main process's global push-to-talk events into mic publication changes. */
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

    // Serialize toggles so a quick tap can't leave the mic on if enable resolves after key-up.
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
              // Unmute failed; don't loop, which would spin while the key is held.
              applied = false;
              stalled = true;
            } else if ((muteFailures += 1) >= MUTE_ATTEMPTS) {
              // Leave `applied` unknown so a later event retries; claiming success would
              // leave the mic live while the UI shows released.
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
      // Force mute before the main process forwards global events, so activation fails closed.
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
      void localParticipant.setMicrophoneEnabled(false).catch(() => {});
      setPushToTalkRuntime({ ready: false, pressed: false, bindingLabel: null });
    };
  }, [localParticipant, preferences.binding, preferences.enabled]);

  return null;
}

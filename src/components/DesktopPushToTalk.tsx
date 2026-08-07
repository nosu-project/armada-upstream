import { useLocalParticipant } from "@livekit/components-react";
import { useEffect } from "react";

import { isDesktop } from "@/lib/desktop";
import {
  configureDesktopPushToTalk,
  onDesktopPushToTalkState,
  setDesktopPushToTalkActive,
  setPushToTalkRuntime,
  usePushToTalkPreferences,
} from "@/lib/pushToTalk";

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
    let unsubscribe = () => {};
    let desired = false;
    let applied: boolean | null = null;
    let applying = false;

    // Serialize LiveKit toggles so a quick tap cannot leave the microphone on
    // if setMicrophoneEnabled(true) resolves after the key-up request.
    const applyDesired = async () => {
      if (applying) return;
      applying = true;
      try {
        while (!disposed && applied !== desired) {
          const next = desired;
          try {
            await localParticipant.setMicrophoneEnabled(next);
          } catch (error) {
            console.warn("push-to-talk microphone toggle failed", error);
          }
          applied = next;
        }
      } finally {
        applying = false;
        if (!disposed && applied !== desired) void applyDesired();
      }
    };

    const setPressed = (pressed: boolean, bindingLabel: string) => {
      desired = pressed;
      setPushToTalkRuntime({ ready: true, pressed, bindingLabel });
      void applyDesired();
    };

    const start = async () => {
      const status = await configureDesktopPushToTalk(preferences.binding);
      if (disposed || !status.supported) return;
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
      void setDesktopPushToTalkActive(false);
      // Always leave the old room muted when changing bindings or unmounting.
      void localParticipant.setMicrophoneEnabled(false).catch(() => {});
      setPushToTalkRuntime({ ready: false, pressed: false, bindingLabel: null });
    };
  }, [localParticipant, preferences.binding, preferences.enabled]);

  return null;
}

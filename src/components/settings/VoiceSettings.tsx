import { useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Switch } from "@/components/ui/switch";
import { rnnoiseSupported } from "@/lib/rnnoiseSupport";
import {
  getAudioProcessing,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";

/** Settings › Voice: devices, push to talk, the voice server, and mic processing. */
export function VoiceSettings() {
  // Mic-processing prefs are device-local (localStorage), not synced AppConfig.
  const [voiceProcessing, setVoiceProcessing] = useState<AudioProcessingPrefs>(() =>
    getAudioProcessing(),
  );
  const setVoiceToggle = (key: keyof AudioProcessingPrefs) => (value: boolean) => {
    setVoiceProcessing((prev) => {
      const next = { ...prev, [key]: value };
      setAudioProcessing(next);
      return next;
    });
  };

  return (
    <>
      <SettingsGroup id="voice" title="Devices">
        <SettingsRow>
          <VoiceDeviceSettings />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Microphone processing" footer="Changes apply to your next call.">
        {rnnoiseSupported() && (
          <SettingsRow
            label="Noise cancellation"
            description="Filters out keyboards, fans and chatter (RNNoise)."
          >
            <Switch
              checked={voiceProcessing.rnnoise}
              onCheckedChange={setVoiceToggle("rnnoise")}
            />
          </SettingsRow>
        )}
        <SettingsRow
          label="Noise suppression"
          description="Filter out background hum and keyboard noise."
        >
          <Switch
            checked={voiceProcessing.noiseSuppression}
            onCheckedChange={setVoiceToggle("noiseSuppression")}
          />
        </SettingsRow>
        <SettingsRow
          label="Echo cancellation"
          description="Stop your speakers from echoing back into the mic."
        >
          <Switch
            checked={voiceProcessing.echoCancellation}
            onCheckedChange={setVoiceToggle("echoCancellation")}
          />
        </SettingsRow>
        <SettingsRow
          label="Auto gain control"
          description="Even out your volume automatically."
        >
          <Switch
            checked={voiceProcessing.autoGainControl}
            onCheckedChange={setVoiceToggle("autoGainControl")}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

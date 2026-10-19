import { useState } from "react";

import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";
import { Switch } from "@/components/ui/switch";
import { useIntl } from "@/i18n";
import { rnnoiseSupported } from "@/lib/rnnoiseSupport";
import {
  getAudioProcessing,
  setAudioProcessing,
  type AudioProcessingPrefs,
} from "@/lib/voiceDevices";

/** Settings › Voice: devices, push to talk, the voice server, and mic processing. */
export function VoiceSettings() {
  const intl = useIntl();
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
      <SettingsGroup id="voice" title={intl.formatMessage({ id: "voiceSettings.devices", defaultMessage: "Devices" })}>
        <SettingsRow>
          <VoiceDeviceSettings />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={intl.formatMessage({ id: "voiceSettings.micProcessing", defaultMessage: "Microphone processing" })}
        footer={intl.formatMessage({ id: "voiceSettings.micProcessingFooter", defaultMessage: "Changes apply to your next call." })}>
        {rnnoiseSupported() && (
          <SettingsRow
            label={intl.formatMessage({ id: "voiceSettings.noiseCancellation", defaultMessage: "Noise cancellation" })}
            description={intl.formatMessage({ id: "voiceSettings.noiseCancellationDescription", defaultMessage: "Filters out keyboards, fans and chatter (RNNoise)." })}
          >
            <Switch
              checked={voiceProcessing.rnnoise}
              onCheckedChange={setVoiceToggle("rnnoise")}
            />
          </SettingsRow>
        )}
        <SettingsRow
          label={intl.formatMessage({ id: "voiceSettings.noiseSuppression", defaultMessage: "Noise suppression" })}
          description={intl.formatMessage({ id: "voiceSettings.noiseSuppressionDescription", defaultMessage: "Filter out background hum and keyboard noise." })}
        >
          <Switch
            checked={voiceProcessing.noiseSuppression}
            onCheckedChange={setVoiceToggle("noiseSuppression")}
          />
        </SettingsRow>
        <SettingsRow
          label={intl.formatMessage({ id: "voiceSettings.echoCancellation", defaultMessage: "Echo cancellation" })}
          description={intl.formatMessage({ id: "voiceSettings.echoCancellationDescription", defaultMessage: "Stop your speakers from echoing back into the mic." })}
        >
          <Switch
            checked={voiceProcessing.echoCancellation}
            onCheckedChange={setVoiceToggle("echoCancellation")}
          />
        </SettingsRow>
        <SettingsRow
          label={intl.formatMessage({ id: "voiceSettings.autoGain", defaultMessage: "Auto gain control" })}
          description={intl.formatMessage({ id: "voiceSettings.autoGainDescription", defaultMessage: "Even out your volume automatically." })}
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

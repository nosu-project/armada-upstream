import { ClipboardCopy, RotateCcw } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import {
  fullPerfReport,
  isRenderTracking,
  resetRuntimeProfile,
  setRenderTracking,
} from "@/lib/perfRuntime";

/**
 * The performance report, reachable without a console. On a phone there is no
 * `__armadaPerf()` to type, and the device that is slow is the one whose
 * numbers matter — so the same JSON the console hands out is one tap away.
 * The report holds relay URLs and filter shapes, never content or keys.
 */
export function DiagnosticsSettings() {
  const [renders, setRenders] = useState(isRenderTracking);

  const copy = () => {
    void writeClipboardText(JSON.stringify(fullPerfReport(), null, 2))
      .then(() => toast({ title: "Performance report copied" }))
      .catch(() => toast({ title: "Couldn't copy the report", variant: "destructive" }));
  };

  return (
    <>
      <SettingsRow
        label="Copy performance report"
        description="Main-thread time, relay traffic, timers, renders and memory since the last reset. Contains relay URLs, no messages or keys."
        onClick={copy}
      >
        <ClipboardCopy className="size-4 text-muted-foreground" />
      </SettingsRow>
      <SettingsRow
        label="Reset counters"
        description="Start a fresh measurement window, e.g. before leaving the app idle for a few minutes."
        onClick={() => {
          resetRuntimeProfile();
          toast({ title: "Performance counters reset" });
        }}
      >
        <RotateCcw className="size-4 text-muted-foreground" />
      </SettingsRow>
      <SettingsRow
        label="Record component renders"
        description="Attribute every React commit to the components that re-rendered. Adds a little overhead while on."
      >
        <Switch
          checked={renders}
          onCheckedChange={(on) => {
            setRenderTracking(on);
            setRenders(on);
          }}
        />
      </SettingsRow>
    </>
  );
}

export default DiagnosticsSettings;

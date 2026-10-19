import { ClipboardCopy, RotateCcw } from "lucide-react";
import { useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/useToast";
import { t, useIntl } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";
import {
  fullPerfReport,
  isRenderTracking,
  nativeServiceProfile,
  resetRuntimeProfile,
  setRenderTracking,
} from "@/lib/perfRuntime";

/** Performance report without a console (for phones). Holds relay URLs and filter shapes, never content or keys. */
export function DiagnosticsSettings() {
  const intl = useIntl();
  const [renders, setRenders] = useState(isRenderTracking);

  const copy = () => {
    const report = fullPerfReport();
    void nativeServiceProfile()
      .then((native) => writeClipboardText(JSON.stringify(native ? { ...report, native } : report, null, 2)))
      .then(() => toast({ title: t({ id: "diagnosticsSettings.reportCopied", defaultMessage: "Performance report copied" }) }))
      .catch(() => toast({ title: t({ id: "diagnosticsSettings.reportCopyFailed", defaultMessage: "Couldn't copy the report" }), variant: "destructive" }));
  };

  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "diagnosticsSettings.copyReport", defaultMessage: "Copy performance report" })}
        description={intl.formatMessage({ id: "diagnosticsSettings.copyReportDescription", defaultMessage: "Main-thread time, relay traffic, timers, renders and memory since the last reset. Contains relay URLs, no messages or keys." })}
        onClick={copy}
      >
        <ClipboardCopy className="size-4 text-muted-foreground" />
      </SettingsRow>
      <SettingsRow
        label={intl.formatMessage({ id: "diagnosticsSettings.resetCounters", defaultMessage: "Reset counters" })}
        description={intl.formatMessage({ id: "diagnosticsSettings.resetCountersDescription", defaultMessage: "Start a fresh measurement window, e.g. before leaving the app idle for a few minutes." })}
        onClick={() => {
          resetRuntimeProfile();
          toast({ title: t({ id: "diagnosticsSettings.countersReset", defaultMessage: "Performance counters reset" }) });
        }}
      >
        <RotateCcw className="size-4 text-muted-foreground" />
      </SettingsRow>
      <SettingsRow
        label={intl.formatMessage({ id: "diagnosticsSettings.recordRenders", defaultMessage: "Record component renders" })}
        description={intl.formatMessage({ id: "diagnosticsSettings.recordRendersDescription", defaultMessage: "Attribute every React commit to the components that re-rendered. Adds a little overhead while on." })}
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

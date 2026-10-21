import { Circle } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import { RecordingFlagIcons } from "@/components/RecordingFlagIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCallRecorder } from "@/contexts/CallRecorderContext";
import { useCallSignals } from "@/contexts/CallSignalsContext";
import { useElapsed } from "@/hooks/useElapsed";
import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

/** {@link RecordingFlagIcons} for an in-call participant. */
export function ParticipantRecordingFlags({ pubkey, className }: { pubkey: string; className?: string }) {
  const signals = useCallSignals().recording;
  if (!signals) return null;
  return (
    <RecordingFlagIcons
      recording={signals.recorders.has(pubkey)}
      refusing={signals.refusing.has(pubkey)}
      className={className}
    />
  );
}

/**
 * A "REC" pill while anyone in the call records, naming them. Ours carries the
 * timer and opens the recorder.
 */
export function RecordingIndicator({ className }: { className?: string }) {
  const intl = useIntl();
  const signals = useCallSignals().recording;
  const recorder = useCallRecorder();
  const mine = recorder.status === "recording";
  const elapsed = useElapsed(mine ? recorder.startedAt : null);
  if (!signals || signals.recorders.size === 0) return null;
  const names = [...signals.recorders];
  const label = intl.formatMessage(
    {
      id: "callRecorder.indicatorLabel",
      defaultMessage: "{count, plural, one {# person is recording this call} other {# people are recording this call}}",
    },
    { count: names.length },
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={recorder.available ? recorder.openDialog : undefined}
          aria-label={label}
          className={cn(
            "shrink-0 inline-flex items-center gap-1 rounded-sm bg-destructive px-1.5 h-5 touch:h-7 touch:px-2 text-3xs font-bold tracking-wide text-destructive-foreground",
            className,
          )}
        >
          <Circle className="size-2 fill-current animate-pulse" aria-hidden />
          <FormattedMessage id="callRecorder.rec" defaultMessage="REC" />
          {mine && <span className="tabular-nums font-medium">{elapsed}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-56">
        <div className="text-xs font-semibold mb-0.5">{label}</div>
        {names.map((pubkey) => (
          <div key={pubkey} className="truncate text-xs">
            <DisplayName pubkey={pubkey} />
          </div>
        ))}
        {signals.noRecord && (
          <div className="mt-1 text-xs text-muted-foreground">
            <FormattedMessage id="callRecorder.youRefuse" defaultMessage="You block recording, so you aren't in it." />
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

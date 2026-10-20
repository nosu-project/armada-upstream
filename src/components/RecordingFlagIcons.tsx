import { Ban, Circle } from "lucide-react";

import { defineMessages, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

const recordingFlagMessages = defineMessages({
  recording: { id: "callRecorder.recording", defaultMessage: "Recording" },
  refusing: { id: "callRecorder.refusing", defaultMessage: "Blocks recording" },
});

/** Small icons for a call member who is recording, or who refuses to be recorded. */
export function RecordingFlagIcons({
  recording,
  refusing,
  className,
}: {
  recording: boolean;
  refusing: boolean;
  className?: string;
}) {
  const intl = useIntl();
  return (
    <>
      {recording && (
        <Circle
          className={cn("size-3 shrink-0 fill-current text-destructive animate-pulse", className)}
          aria-label={intl.formatMessage(recordingFlagMessages.recording)}
        />
      )}
      {refusing && (
        <Ban
          className={cn("size-3 shrink-0 text-muted-foreground", className)}
          aria-label={intl.formatMessage(recordingFlagMessages.refusing)}
        />
      )}
    </>
  );
}

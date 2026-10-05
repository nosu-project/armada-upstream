import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { writeClipboardText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** Scrollable JSON with a copy button pinned to its corner (outside the scroll, so it stays put). */
export function JsonBlock({ json, className }: { json: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  return (
    <div className={cn("relative min-w-0", className)}>
      <pre className="max-h-[60vh] overflow-auto clip-corner-lg bg-background/40 p-3 pr-14 font-mono text-xs leading-relaxed">
        {json}
      </pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy JSON"}
        title={copied ? "Copied" : "Copy JSON"}
        onClick={() => {
          writeClipboardText(json).then(
            () => {
              setCopied(true);
              clearTimeout(resetTimer.current);
              resetTimer.current = setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
        className={cn(
          "absolute right-2 top-2 inline-flex size-8 touch:size-11 items-center justify-center clip-corner bg-chrome transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          copied ? "text-primary" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

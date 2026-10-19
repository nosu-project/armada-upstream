import { useState } from "react";

import { cn } from "@/lib/utils";
import { useIntl } from "@/i18n";

import type { ReactNode } from "react";

/** Discord-style `||spoiler||`: covered until clicked. */
export function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  const intl = useIntl();
  return (
    <span
      role={revealed ? undefined : "button"}
      tabIndex={revealed ? undefined : 0}
      aria-label={revealed ? undefined : intl.formatMessage({ id: "spoiler.reveal", defaultMessage: "Reveal spoiler" })}
      // Capture, and its content takes no pointer events while covered: the first
      // click reveals, rather than following a link or opening a profile inside.
      onClickCapture={(e) => {
        if (revealed) return;
        e.preventDefault();
        e.stopPropagation();
        setRevealed(true);
      }}
      onKeyDown={(e) => {
        if (revealed) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setRevealed(true);
        }
      }}
      className={cn(
        "rounded px-0.5 transition-colors [box-decoration-break:clone] [-webkit-box-decoration-break:clone]",
        revealed
          ? "bg-foreground/10"
          : "bg-foreground/20 hover:bg-foreground/30 text-transparent cursor-pointer select-none [&_*]:pointer-events-none [&_*]:!text-transparent [&_*]:!bg-transparent [&_*]:!border-transparent [&_img]:invisible",
      )}
    >
      {children}
    </span>
  );
}

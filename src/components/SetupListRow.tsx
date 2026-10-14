import { ChevronDown } from "lucide-react";

import { BlossomLed, RelayLed } from "@/components/RelayLed";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

/** A URL as a row shows it: no scheme, no trailing slash. */
function setupHost(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

/**
 * One relay or media-server list as a collapsed row: its name, its first
 * entry's host and status light, and how many more it holds. Opens to the
 * list's editor. Settings › Relays draws its rows with this.
 */
export function SetupListRow({
  label,
  hint,
  detail,
  urls,
  kind = "relay",
  open,
  onOpenChange,
  padX = "px-3",
  children,
}: {
  label: string;
  /** One line under the editor when open (and `detail` is absent). */
  hint: string;
  /** Fuller copy than `hint`, shown in its place when open. */
  detail?: ReactNode;
  urls: string[];
  kind?: "relay" | "blossom";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Horizontal padding class, so the row lines up with its container's other rows. */
  padX?: string;
  children: ReactNode;
}) {
  const first = urls[0];
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <button type="button" className={cn("flex w-full items-center gap-3 py-3 text-left touch:min-h-12", padX)}>
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="ml-auto flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
            {first && (kind === "blossom" ? <BlossomLed url={first} /> : <RelayLed url={first} />)}
            <span className="truncate">
              {first ? setupHost(first) : "None"}
              {urls.length > 1 && ` +${urls.length - 1}`}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <div className={cn("space-y-2 pb-3", padX)}>
          <div className="text-xs leading-snug text-muted-foreground">{detail ?? hint}</div>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

import { Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { toast } from "@/hooks/useToast";
import { normalizeRelayUrl } from "@/lib/platform";

function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^wss?:\/\//, "");
  }
}

/** Relay row with NIP-11 identity and NIP-42/50 badges (adapted from Ditto). */
function RelayIdentity({ url }: { url: string }) {
  const { data: info } = useRelayInfo(url);
  const host = relayHost(url);
  const name = info?.name || host;
  const nips = (info?.supported_nips ?? []).filter((nip) => nip === 42 || nip === 50);

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar className="size-7 rounded-md shrink-0">
        <AvatarImage src={info?.icon} alt={name} />
        <AvatarFallback className="rounded-md bg-secondary text-secondary-foreground text-xs">
          {name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-medium truncate leading-tight">{name}</div>
        <div className="text-xs text-muted-foreground font-mono truncate leading-tight">{host}</div>
      </div>
      <div className="flex items-center gap-1 ml-auto shrink-0">
        {nips.includes(50) && <Badge variant="outline" className="text-[10px] px-1.5">NIP-50</Badge>}
        {nips.includes(42) && <Badge variant="outline" className="text-[10px] px-1.5">NIP-42</Badge>}
      </div>
    </div>
  );
}

export interface RelayListEditorProps {
  relays: string[];
  /** Omit (with `readOnly`) for a display-only list. */
  onChange?: (relays: string[]) => void;
  /** Read-only, non-removable relays shown first (e.g. the app defaults). */
  pinned?: string[];
  pinnedLabel?: string;
  onReset?: () => void;
  emptyText?: string;
  placeholder?: string;
  readOnly?: boolean;
}

/** Relay list editor mirroring Ditto's RelayListManager, as a plain `string[]` (no read/write markers). */
export function RelayListEditor({
  relays,
  onChange,
  pinned = [],
  pinnedLabel = "Default",
  onReset,
  emptyText = "No relays configured.",
  placeholder = "wss://relay.example.com",
  readOnly = false,
}: RelayListEditorProps) {
  const [newUrl, setNewUrl] = useState("");

  const handleAdd = () => {
    const normalized = normalizeRelayUrl(newUrl);
    if (!normalized) {
      toast({ title: "Invalid relay URL", description: "Enter a ws:// or wss:// URL.", variant: "destructive" });
      return;
    }
    if (pinned.includes(normalized) || relays.includes(normalized)) {
      toast({ title: "Already in the list", description: normalized });
      return;
    }
    onChange?.([...relays, normalized]);
    setNewUrl("");
  };

  return (
    <div className="space-y-1.5">
      {pinned.map((url) => (
        <div key={url} className="flex items-center gap-2 rounded-md bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <RelayIdentity url={url} />
          </div>
          <span className="text-xs text-muted-foreground shrink-0 ml-1">{pinnedLabel}</span>
        </div>
      ))}

      {relays.map((url) => (
        <div key={url} className="flex items-center gap-2 rounded-md bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <RelayIdentity url={url} />
          </div>
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${url}`}
              className="size-7 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => onChange?.(relays.filter((u) => u !== url))}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      ))}

      {relays.length === 0 && pinned.length === 0 && (
        <p className="text-sm text-muted-foreground py-1">{emptyText}</p>
      )}

      {!readOnly && (
        <form
          className="flex gap-2 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder={placeholder}
            aria-label="Add relay"
            autoComplete="off"
            className="text-base md:text-sm bg-background/40 border-transparent"
          />
          <Button type="submit" disabled={!newUrl.trim()} className="clip-corner-lg shrink-0">
            <Plus className="size-4 mr-1.5" /> Add
          </Button>
        </form>
      )}

      {!readOnly && onReset && (
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2" onClick={onReset}>
          <RotateCcw className="size-3.5 mr-1.5" /> Reset to defaults
        </Button>
      )}
    </div>
  );
}

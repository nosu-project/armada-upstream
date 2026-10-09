import { ArrowUpToLine, Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { normalizeBlossomServerUrl } from "@/lib/blossom";

function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

/** One server row, shaped like RelayListEditor's RelayIdentity minus NIP-11 bits. */
function ServerIdentity({ url }: { url: string }) {
  const host = serverHost(url);
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar className="size-7 rounded-md shrink-0">
        <AvatarFallback className="rounded-md bg-secondary text-secondary-foreground text-xs">
          {host.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-medium truncate leading-tight">{host}</div>
        <div className="text-xs text-muted-foreground font-mono truncate leading-tight">{url}</div>
      </div>
    </div>
  );
}

export interface BlossomServerListEditorProps {
  /** Editable server URLs (the user's kind 10063 list), most trusted first. */
  servers: string[];
  onChange: (servers: string[]) => void;
  onReset?: () => void;
  emptyText?: string;
  placeholder?: string;
}

/**
 * Blossom server list editor; the https sibling of RelayListEditor. The first
 * server is the primary one (BUD-03), whose links uploads embed.
 */
export function BlossomServerListEditor({
  servers,
  onChange,
  onReset,
  emptyText = "No media servers configured.",
  placeholder = "https://blossom.example.com",
}: BlossomServerListEditorProps) {
  const [newUrl, setNewUrl] = useState("");

  const handleAdd = () => {
    const normalized = normalizeBlossomServerUrl(newUrl);
    if (!normalized) {
      toast({
        title: "Invalid server URL",
        description: "Enter an https:// URL.",
        variant: "destructive",
      });
      return;
    }
    if (servers.includes(normalized)) {
      toast({ title: "Already in the list", description: normalized });
      return;
    }
    onChange([...servers, normalized]);
    setNewUrl("");
  };

  return (
    <div className="space-y-1.5">
      {servers.map((url, index) => (
        <div key={url} className="flex items-center gap-2 clip-corner bg-background/40 px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <ServerIdentity url={url} />
          </div>
          {index === 0 ? (
            <span className="text-xs text-muted-foreground shrink-0 ml-1">Primary</span>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Make ${url} primary`}
              title="Make primary"
              className="size-7 touch:size-11 text-muted-foreground hover:text-foreground shrink-0"
              onClick={() => onChange([url, ...servers.filter((u) => u !== url)])}
            >
              <ArrowUpToLine className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${url}`}
            className="size-7 touch:size-11 text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => onChange(servers.filter((u) => u !== url))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}

      {servers.length === 0 && (
        <p className="text-sm text-muted-foreground py-1">{emptyText}</p>
      )}

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
          aria-label="Add media server"
          autoComplete="off"
          className="text-base md:text-sm bg-background/40 border-transparent"
        />
        <Button type="submit" disabled={!newUrl.trim()} className="clip-corner-lg shrink-0">
          <Plus className="size-4 mr-1.5" /> Add
        </Button>
      </form>

      {onReset && (
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2" onClick={onReset}>
          <RotateCcw className="size-3.5 mr-1.5" /> Reset to defaults
        </Button>
      )}
    </div>
  );
}

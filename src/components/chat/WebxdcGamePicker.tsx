import { useMemo, useState } from "react";
import { Blocks, ImageOff, Loader2, Search } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWebxdcApps, type WebxdcApp } from "@/hooks/useWebxdcApps";

/** One game row: icon + name, clickable to attach. */
function GameRow({ app, onPick }: { app: WebxdcApp; onPick: (app: WebxdcApp) => void }) {
  const [iconError, setIconError] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onPick(app)}
      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left hover:bg-secondary/60 transition-colors"
    >
      <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
        {app.icon && !iconError ? (
          <img
            src={app.icon}
            alt=""
            className="size-full object-cover"
            onError={() => setIconError(true)}
          />
        ) : (
          <Blocks className="size-5 text-primary" />
        )}
      </div>
      <span className="text-sm font-medium truncate">{app.name}</span>
    </button>
  );
}

/**
 * Browse webxdc apps/games published as Nostr events (NIP-94 kind 1063) and pick
 * one to attach to a message. Discovery is read-only; `onPick` hands the chosen
 * app back to the composer, which attaches it with a fresh shared session id.
 */
export function WebxdcGamePicker({
  open,
  onOpenChange,
  onPick,
  relays,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (app: WebxdcApp) => void;
  /** Extra relays to search alongside the default pool (e.g. the community's). */
  relays?: string[];
}) {
  const [query, setQuery] = useState("");
  const { data: apps, isLoading, isError } = useWebxdcApps(relays);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps ?? [];
    return (apps ?? []).filter((a) => a.name.toLowerCase().includes(q));
  }, [apps, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Blocks className="size-4 text-primary" /> Add a game
          </DialogTitle>
        </DialogHeader>

        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search games"
              className="pl-8 h-9 text-base md:text-sm bg-muted/50 border-0 rounded-lg"
            />
          </div>
        </div>

        <ScrollArea className="h-[50dvh] max-h-96 px-2 pb-2">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <Loader2 className="size-6 animate-spin mb-2" />
              <p className="text-sm">Finding games…</p>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <ImageOff className="size-8 mb-2 opacity-40" />
              <p className="text-sm">Couldn't load games</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground px-6 text-center">
              <Blocks className="size-8 mb-2 opacity-40" />
              <p className="text-sm">{query ? "No games match your search" : "No games found yet"}</p>
              <p className="text-xs mt-1">
                {query ? "Try a different name." : "Publish a .xdc as a kind-1063 event to list it here."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((app) => (
                <GameRow key={app.id} app={app} onPick={onPick} />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

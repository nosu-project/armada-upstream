import { useEffect, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { desktop, type ScreenSource } from "@/lib/desktop";

/**
 * Screen-share source picker for the desktop app.
 *
 * Electron has no built-in getDisplayMedia picker, so the main process asks the
 * renderer to choose a source. This component registers that handler (via the
 * desktop bridge) and shows a grid of screens/windows; the user's choice (or
 * cancel) resolves the pending getDisplayMedia call.
 *
 * Renders nothing on the web (the bridge is absent).
 */
export function ScreenSharePicker() {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ScreenSource[]>([]);
  // The resolver for the in-flight pick; called with the chosen id or null.
  const resolveRef = useRef<((id: string | null) => void) | null>(null);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;

    bridge.onPickScreenSource(async () => {
      const list = await bridge.getScreenSources();
      setSources(list);
      setOpen(true);
      return new Promise<string | null>((resolve) => {
        resolveRef.current = resolve;
      });
    });
  }, []);

  const choose = (id: string | null) => {
    setOpen(false);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(id);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && choose(null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share your screen</DialogTitle>
          <DialogDescription>Choose a screen or window to share.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto sm:grid-cols-3">
          {sources.map((s) => (
            <button
              key={s.id}
              onClick={() => choose(s.id)}
              className="group flex flex-col gap-2 rounded-lg border border-border p-2 text-left hover:border-primary hover:bg-accent/50 transition-colors"
            >
              {s.thumbnail ? (
                <img
                  src={s.thumbnail}
                  alt=""
                  className="aspect-video w-full rounded object-cover bg-muted"
                />
              ) : (
                <div className="aspect-video w-full rounded bg-muted" />
              )}
              <div className="flex items-center gap-2 min-w-0">
                {s.appIcon && <img src={s.appIcon} alt="" className="size-4 shrink-0" />}
                <span className="truncate text-xs">{s.name}</span>
              </div>
            </button>
          ))}
          {sources.length === 0 && (
            <p className="col-span-full text-sm text-muted-foreground">
              No screens or windows available to share.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

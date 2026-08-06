import { useEffect, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  desktop,
  desktopShareAudioSources,
  prepareDesktopShareAudio,
  stopDesktopShareAudio,
  type LinuxShareAudioSources,
  type ScreenSource,
} from "@/lib/desktop";

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
  const [audio, setAudio] = useState<LinuxShareAudioSources | null>(null);
  const [audioChoice, setAudioChoice] = useState("system");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // The resolver for the in-flight pick; called with the chosen id or null.
  const resolveRef = useRef<((id: string | null) => void) | null>(null);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;

    bridge.onPickScreenSource(async () => {
      const [screenSources, audioSources] = await Promise.all([
        bridge.getScreenSources(),
        desktopShareAudioSources(),
      ]);
      setSources(screenSources);
      setAudio(audioSources.reason === null && !audioSources.supported ? null : audioSources);
      setAudioChoice("system");
      setAudioError(null);
      setChoosing(false);
      setOpen(true);
      return new Promise<string | null>((resolve) => {
        resolveRef.current = resolve;
      });
    });
  }, []);

  const finish = (id: string | null) => {
    setOpen(false);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(id);
  };

  const cancel = () => {
    if (!resolveRef.current) return;
    void stopDesktopShareAudio();
    finish(null);
  };

  const choose = async (id: string) => {
    if (choosing) return;
    setChoosing(true);
    setAudioError(null);

    if (audio?.supported && audioChoice !== "none") {
      const prepared = await prepareDesktopShareAudio(
        audioChoice === "system"
          ? { mode: "system" }
          : { mode: "applications", sourceIds: [audioChoice.slice(4)] },
      );
      if (!prepared) {
        setAudioError("Application audio could not be started. Choose No audio or try again.");
        setChoosing(false);
        return;
      }
    } else {
      await stopDesktopShareAudio();
    }

    finish(id);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share your screen</DialogTitle>
          <DialogDescription>
            Choose a screen or window and, on Linux, the audio to share.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 max-h-[48vh] overflow-y-auto sm:grid-cols-3">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={choosing}
              onClick={() => void choose(s.id)}
              className="group flex flex-col gap-2 rounded-lg border border-border p-2 text-left transition-colors hover:border-primary hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
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
        {audio && (
          <div className="space-y-2 border-t border-border pt-4">
            <Label htmlFor="screen-share-audio">Share audio</Label>
            {audio.supported ? (
              <Select value={audioChoice} onValueChange={setAudioChoice} disabled={choosing}>
                <SelectTrigger id="screen-share-audio">
                  <SelectValue placeholder="Choose audio" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">Entire system</SelectItem>
                  {audio.sources.map((source) => (
                    <SelectItem key={source.id} value={`app:${source.id}`}>
                      {source.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="none">No audio</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                {audio.reason || "Application audio is unavailable in this Linux session."}
              </p>
            )}
            {audioError && <p className="text-sm text-destructive">{audioError}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

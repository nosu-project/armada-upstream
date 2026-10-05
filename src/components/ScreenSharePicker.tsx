import { MonitorUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChromeDialogContent, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
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
  declineDesktopShareAudio,
  desktopShareAudioSources,
  prepareDesktopShareAudio,
  type LinuxShareAudioSources,
  type ScreenSource,
} from "@/lib/desktop";

function activeFullscreenContainer(): HTMLElement | undefined {
  const element = document.fullscreenElement;
  return element instanceof HTMLElement ? element : undefined;
}

/** Electron has no getDisplayMedia picker: this handles the main process's source request. No-op on web. */
export function ScreenSharePicker() {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [showScreenRecordingSettings, setShowScreenRecordingSettings] = useState(false);
  const [audio, setAudio] = useState<LinuxShareAudioSources | null>(null);
  const [audioChoice, setAudioChoice] = useState("system");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | undefined>(
    activeFullscreenContainer,
  );
  const resolveRef = useRef<((id: string | null) => void) | null>(null);

  useEffect(() => {
    const updatePortalContainer = () => setPortalContainer(activeFullscreenContainer());
    document.addEventListener("fullscreenchange", updatePortalContainer);
    return () => document.removeEventListener("fullscreenchange", updatePortalContainer);
  }, []);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;

    bridge.onPickScreenSource(async () => {
      setPortalContainer(activeFullscreenContainer());
      try {
        const [screenSources, audioSources] = await Promise.all([
          bridge.getScreenSources(),
          desktopShareAudioSources(),
        ]);
        setSources(screenSources);
        setSourceError(
          screenSources.length === 0 ? "No screens or windows are available to share." : null,
        );
        setShowScreenRecordingSettings(false);
        setAudio(audioSources.reason === null && !audioSources.supported ? null : audioSources);
      } catch {
        setSources([]);
        let macDenied = false;
        try {
          const [{ platform }, status] = await Promise.all([
            bridge.getInfo(),
            bridge.getScreenCaptureAccessStatus?.() ?? Promise.resolve("unknown"),
          ]);
          macDenied = platform === "darwin" && (status === "denied" || status === "restricted");
        } catch { /* ignore */ }
        setSourceError(
          macDenied
            ? "Armada needs Screen Recording permission in macOS Privacy & Security."
            : "Armada couldn't open the system screen picker. Check your operating system's screen-capture permission or picker service and try again.",
        );
        setShowScreenRecordingSettings(
          macDenied && Boolean(bridge.openScreenCapturePrivacySettings),
        );
        setAudio(null);
      }
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
      // Don't unlink: the user can still cancel back into the live share.
      declineDesktopShareAudio();
    }

    finish(id);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && cancel()}>
      <ChromeDialogContent
        title="Share your screen"
        className="sm:max-w-2xl"
        contentClassName="grid gap-4"
        portalContainer={portalContainer}
      >
        <ChromeDialogHeader
          icon={MonitorUp}
          title="share your screen"
          description="Choose a screen or window and, on Linux, the audio to share."
          className="mb-2"
        />
        <div className="grid grid-cols-2 gap-3 max-h-[48vh] overflow-y-auto sm:grid-cols-3">
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={choosing}
              onClick={() => void choose(s.id)}
              className="group flex flex-col gap-2 clip-corner-lg bg-background/40 p-2 text-left transition-colors hover:bg-primary/15 disabled:pointer-events-none disabled:opacity-50"
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
          {sourceError && (
            <div className="col-span-full space-y-2">
              <p className="text-sm text-destructive">{sourceError}</p>
              {showScreenRecordingSettings && (
                <button
                  type="button"
                  className="text-sm font-medium text-primary hover:underline"
                  onClick={() => void desktop()?.openScreenCapturePrivacySettings?.()}
                >
                  Open Screen Recording settings
                </button>
              )}
            </div>
          )}
        </div>
        {audio && (
          <div className="space-y-2 border-t border-chrome pt-4">
            <Label htmlFor="screen-share-audio">Share audio</Label>
            {audio.supported ? (
              <Select value={audioChoice} onValueChange={setAudioChoice} disabled={choosing}>
                <SelectTrigger id="screen-share-audio">
                  <SelectValue placeholder="Choose audio" />
                </SelectTrigger>
                <SelectContent portalContainer={portalContainer}>
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
      </ChromeDialogContent>
    </Dialog>
  );
}

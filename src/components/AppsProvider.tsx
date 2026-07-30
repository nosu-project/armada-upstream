import { Blocks, Maximize2, Minimize2, MonitorPlay, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { WebxdcApp } from "@/components/apps/WebxdcApp";
import { YouTubeWatchalong } from "@/components/apps/YouTubeWatchalong";
import { Button } from "@/components/ui/button";
import { useConcordAppSync } from "@/concord-v1/hooks/useConcordAppSync";
import { useConcord2AppSync } from "@/concord-v2/hooks/useConcord2AppSync";
import { useGroupAppSync } from "@/hooks/useGroupAppSync";
import {
  AppsContext,
  appScopeKey,
  defaultSessionId,
  type ActiveApp,
  type AppKind,
  type AppScope,
} from "@/contexts/AppsContext";
import type { AppSync } from "@/hooks/useWebxdcApi";
import { cn } from "@/lib/utils";

/** A short human label + icon for the running app, shown in the stage header. */
function appHeader(app: AppKind): { label: string; icon: React.ReactNode } {
  if (app.type === "youtube") {
    return { label: "Watch together", icon: <MonitorPlay className="size-4 text-[#ff0000]" /> };
  }
  return { label: app.name ?? "Webxdc app", icon: <Blocks className="size-4 text-primary" /> };
}

/** The app surface (player / iframe), given a resolved sync backend. */
function AppSurface({ app, sessionId, sync }: { app: AppKind; sessionId: string; sync: AppSync }) {
  if (app.type === "youtube") {
    return <YouTubeWatchalong sync={sync} />;
  }
  return <WebxdcApp sync={sync} url={app.url} sessionId={sessionId} name={app.name} encryption={app.encryption} />;
}

/** Render a running NIP-29-scoped app (resolves the group sync backend). */
function Nip29RunningApp({
  active,
  relayUrl,
  groupId,
  children,
}: {
  active: ActiveApp;
  relayUrl: string;
  groupId: string;
  children: (sync: AppSync) => React.ReactNode;
}) {
  const sync = useGroupAppSync(relayUrl, groupId, active.sessionId);
  return <>{children(sync)}</>;
}

/** Render a running Concord v1-scoped app (resolves the sealed channel sync backend). */
function ConcordRunningApp({
  active,
  children,
}: {
  active: ActiveApp & { scope: Extract<AppScope, { kind: "concord" }> };
  children: (sync: AppSync) => React.ReactNode;
}) {
  const sync = useConcordAppSync(active.scope.community, active.scope.channel, active.sessionId);
  return <>{children(sync)}</>;
}

/** Render a running Concord v2-scoped app (resolves the sealed channel sync backend). */
function Concord2RunningApp({
  active,
  children,
}: {
  active: ActiveApp & { scope: Extract<AppScope, { kind: "concord2" }> };
  children: (sync: AppSync) => React.ReactNode;
}) {
  const sync = useConcord2AppSync(active.scope.community, active.scope.channel, active.sessionId);
  return <>{children(sync)}</>;
}

/**
 * The mounted, persistent app: resolves the right coordination backend for its
 * chat scope and portals the app stage into every registered top-of-chat slot
 * (in practice the single chat surface matching the app's scope). Kept mounted
 * by `AppsProvider` so the app/session survives navigation.
 */
function RunningApp({
  active,
  slots,
  stageOpen,
  onClose,
  onToggle,
}: {
  active: ActiveApp;
  slots: HTMLElement[];
  stageOpen: boolean;
  onClose: () => void;
  onToggle: () => void;
}) {
  const { label, icon } = appHeader(active.app);

  const renderStage = (sync: AppSync) => {
    const stage = (
      <div className="px-1 pt-1">
        <div className="clip-corner-lg bg-chrome shadow-lg overflow-hidden">
          <div className={cn(
            "flex items-center gap-2 px-3 py-2",
            active.app.type !== "webxdc" && "border-b border-border/50",
          )}>
            {icon}
            <span className="text-sm font-medium truncate flex-1 min-w-0">{label}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={stageOpen ? "Minimize app" : "Expand app"}
              onClick={onToggle}
            >
              {stageOpen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label="Close app"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
          {stageOpen && (
            <div className="p-2 max-h-[80vh] overflow-y-auto">
              <AppSurface app={active.app} sessionId={active.sessionId} sync={sync} />
            </div>
          )}
        </div>
      </div>
    );
    return (
      <>
        {slots.map((el, i) => createPortal(stage, el, `app-stage-slot-${i}`))}
      </>
    );
  };

  if (active.scope.kind === "nip29") {
    return (
      <Nip29RunningApp active={active} relayUrl={active.scope.relayUrl} groupId={active.scope.groupId}>
        {renderStage}
      </Nip29RunningApp>
    );
  }
  if (active.scope.kind === "concord2") {
    return (
      <Concord2RunningApp active={active as ActiveApp & { scope: Extract<AppScope, { kind: "concord2" }> }}>
        {renderStage}
      </Concord2RunningApp>
    );
  }
  return (
    <ConcordRunningApp active={active as ActiveApp & { scope: Extract<AppScope, { kind: "concord" }> }}>
      {renderStage}
    </ConcordRunningApp>
  );
}

/**
 * App-level in-chat apps state. Holds the open app and renders it persistently
 * (mounted once in the never-unmounting MainLayout) so an app — and its
 * coordination session — survives navigation between channels/servers, exactly
 * like the voice `CallProvider`.
 */
export function AppsProvider({ children }: { children: React.ReactNode }) {
  const [activeApp, setActiveApp] = useState<ActiveApp | null>(null);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const [stageOpen, setStageOpen] = useState(true);

  const launchApp = useCallback((scope: AppScope, app: AppKind, sessionId?: string) => {
    // Default to a deterministic, scope-derived session so everyone in the
    // channel joins the SAME shared app (not a private per-person instance).
    const id = sessionId ?? defaultSessionId(scope, app);
    setStageOpen(true);
    setActiveApp({ scope, app, sessionId: id });
  }, []);

  const closeApp = useCallback(() => {
    setActiveApp(null);
  }, []);

  const registerAppStageSlot = useCallback((el: HTMLElement) => {
    setSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  const toggleStage = useCallback(() => setStageOpen((o) => !o), []);

  const value = useMemo(
    () => ({
      activeApp,
      launchApp,
      closeApp,
      registerAppStageSlot,
      stageOpen,
      toggleStage,
      setStageOpen,
    }),
    [activeApp, launchApp, closeApp, registerAppStageSlot, stageOpen, toggleStage],
  );

  return (
    <AppsContext.Provider value={value}>
      {children}
      {activeApp && (
        <RunningApp
          // Remount only when the app/scope/session changes.
          key={`${appScopeKey(activeApp.scope)}|${activeApp.sessionId}`}
          active={activeApp}
          slots={slots}
          stageOpen={stageOpen}
          onClose={closeApp}
          onToggle={toggleStage}
        />
      )}
    </AppsContext.Provider>
  );
}

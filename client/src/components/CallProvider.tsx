import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import "@livekit/components-styles";

import { InCallView } from "@/components/chat/VoiceBar";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useGroup } from "@/hooks/useGroup";
import { useLivekitToken } from "@/hooks/useLivekit";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { CallContext, type ActiveCall } from "@/contexts/CallContext";
import { relayToRouteParam } from "@/lib/platform";
import { cn } from "@/lib/utils";

/**
 * The persistent voice room. Mounted once by `CallProvider` (which lives in the
 * never-unmounting MainLayout), so the LiveKit connection survives navigation
 * between channels and servers.
 *
 * The call UI renders in two places (both inside this one room context): a
 * fixed bottom bar on mobile, and — when a channel sidebar registers a slot —
 * portaled above the account pill on desktop.
 */
function PersistentVoiceRoom({
  call,
  onLeave,
  slots,
}: {
  call: ActiveCall;
  onLeave: () => void;
  slots: HTMLElement[];
}) {
  const navigate = useNavigate();
  const { data: tokenData, error, isLoading } = useLivekitToken(call.relayUrl, call.groupId, true);
  const { data: details } = useGroup(call.relayUrl, call.groupId);
  const { data: relayInfo } = useRelayInfo(call.relayUrl);
  const channelName = details?.group?.name ?? "voice";
  const serverName = relayInfo?.name ?? call.relayUrl.replace(/^wss?:\/\//, "");

  const handleDisconnected = useCallback(() => onLeave(), [onLeave]);

  const goToChannel = () => {
    navigate(`/s/${relayToRouteParam(call.relayUrl)}/${encodeURIComponent(call.groupId)}`);
  };

  // Place content in: the fixed bottom bar (mobile main view), and every
  // registered sidebar slot (desktop pane + mobile drawer, above their account
  // pill). `desktop` defaults to `mobile` when not given (loading/error).
  const placeBar = (mobile: React.ReactNode, desktop?: React.ReactNode) => (
    <>
      <div className="fixed bottom-0 inset-x-0 z-40 px-2 pb-safe sidebar:hidden">{mobile}</div>
      {slots.map((el, i) =>
        createPortal(<div className="px-1 pb-1">{desktop ?? mobile}</div>, el, `call-slot-${i}`),
      )}
    </>
  );

  if (isLoading) {
    return placeBar(
      <div className="flex items-center justify-center gap-2 px-3 py-2 clip-corner-lg bg-black/40 min-h-12 shadow-lg">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Requesting voice access…</span>
      </div>,
    );
  }

  if (error || !tokenData) {
    return placeBar(
      <div className="flex items-center gap-2 px-3 py-2 clip-corner-lg bg-black/40 min-h-12 shadow-lg">
        <span className="text-sm text-destructive flex-1 min-w-0 truncate">
          Could not join voice{error instanceof Error ? `: ${error.message}` : "."}
        </span>
        <Button className="h-8 px-3 text-sm shrink-0" variant="outline" onClick={onLeave}>
          Back
        </Button>
      </div>,
    );
  }

  const label = <><span className="text-muted-foreground/70">{serverName}</span>{" "}#{channelName}</>;

  const mobileBar = (
    <div className="clip-corner-lg bg-black/40 shadow-lg">
      <InCallView label={label} onLabelClick={goToChannel} />
    </div>
  );

  const desktopBar = (
    <div className="clip-corner-lg bg-black/40 shadow-lg">
      <InCallView label={label} onLabelClick={goToChannel} stacked />
    </div>
  );

  return (
    <LiveKitRoom
      serverUrl={tokenData.url}
      token={tokenData.token}
      connect
      audio
      video={false}
      onDisconnected={handleDisconnected}
      // `display: contents` so the room container generates no box of its own:
      // it must not take flex space or paint a background over the chat. The
      // visible UI is the fixed/portaled bars below, positioned independently.
      style={{ display: "contents" }}
    >
      <RoomAudioRenderer />
      {placeBar(mobileBar, desktopBar)}
    </LiveKitRoom>
  );
}

/**
 * App-level voice call state. Holds the active room and renders the persistent
 * LiveKitRoom so navigation doesn't tear down the call.
 */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [slots, setSlots] = useState<HTMLElement[]>([]);

  const joinCall = useCallback((relayUrl: string, groupId: string) => {
    setActiveCall({ relayUrl, groupId });
  }, []);

  const leaveCall = useCallback(() => setActiveCall(null), []);

  const registerCallBarSlot = useCallback((el: HTMLElement) => {
    setSlots((prev) => (prev.includes(el) ? prev : [...prev, el]));
    return () => setSlots((prev) => prev.filter((s) => s !== el));
  }, []);

  return (
    <CallContext.Provider value={{ activeCall, joinCall, leaveCall, registerCallBarSlot }}>
      <div
        className={cn(
          "relative flex h-full w-full overflow-hidden",
          // On mobile the call bar is a fixed bottom overlay; reserve space so
          // it doesn't cover the chat composer. On desktop the bar lives in the
          // sidebar slot, so no reservation is needed.
          user && activeCall && "max-sidebar:pb-[var(--call-bar-h)]",
        )}
        style={user && activeCall ? ({ "--call-bar-h": "3.25rem" } as React.CSSProperties) : undefined}
      >
        {children}
        {user && activeCall && (
          // `key` remounts the connection only when switching rooms.
          <PersistentVoiceRoom
            key={`${activeCall.relayUrl}|${activeCall.groupId}`}
            call={activeCall}
            onLeave={leaveCall}
            slots={slots}
          />
        )}
      </div>
    </CallContext.Provider>
  );
}

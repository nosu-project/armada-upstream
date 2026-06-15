import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
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

/**
 * The persistent voice room. Mounted once by `CallProvider` (which lives in the
 * never-unmounting MainLayout), so the LiveKit connection survives navigation
 * between channels and servers. Renders a docked global call bar.
 */
function PersistentVoiceRoom({ call, onLeave }: { call: ActiveCall; onLeave: () => void }) {
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

  if (isLoading) {
    return (
      <div className="mx-2 mb-2 flex items-center justify-center gap-2 px-3 py-2 clip-corner-lg bg-black/40 min-h-12">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Requesting voice access…</span>
      </div>
    );
  }

  if (error || !tokenData) {
    return (
      <div className="mx-2 mb-2 flex items-center gap-2 px-3 py-2 clip-corner-lg bg-black/40 min-h-12">
        <span className="text-sm text-destructive flex-1 min-w-0 truncate">
          Could not join voice{error instanceof Error ? `: ${error.message}` : "."}
        </span>
        <Button className="h-8 px-3 text-sm shrink-0" variant="outline" onClick={onLeave}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-2 mb-2 clip-corner-lg bg-black/40">
      <LiveKitRoom
        serverUrl={tokenData.url}
        token={tokenData.token}
        connect
        audio
        video={false}
        onDisconnected={handleDisconnected}
        data-lk-theme="default"
      >
        <RoomAudioRenderer />
        <InCallView
          label={<><span className="text-muted-foreground/70">{serverName}</span>{" "}#{channelName}</>}
          onLabelClick={goToChannel}
        />
      </LiveKitRoom>
    </div>
  );
}

/**
 * App-level voice call state. Holds the active room and renders the persistent
 * LiveKitRoom so navigation doesn't tear down the call.
 */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);

  const joinCall = useCallback((relayUrl: string, groupId: string) => {
    setActiveCall({ relayUrl, groupId });
  }, []);

  const leaveCall = useCallback(() => setActiveCall(null), []);

  return (
    <CallContext.Provider value={{ activeCall, joinCall, leaveCall }}>
      <div className="flex flex-col h-full w-full overflow-hidden">
        <div className="flex flex-1 min-h-0 w-full overflow-hidden">
          {children}
        </div>
        {user && activeCall && (
          // `key` ensures switching rooms remounts the connection cleanly;
          // staying in the same room keeps the LiveKitRoom instance (and
          // WebRTC) alive across all navigation.
          <div className="shrink-0 pb-safe">
            <PersistentVoiceRoom
              key={`${activeCall.relayUrl}|${activeCall.groupId}`}
              call={activeCall}
              onLeave={leaveCall}
            />
          </div>
        )}
      </div>
    </CallContext.Provider>
  );
}

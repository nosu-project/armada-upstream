import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  ArrowLeft,
  Bluetooth,
  BluetoothOff,
  Hash,
  Loader2,
  MessageCircle,
  Radio,
  Send,
  Users,
} from "lucide-react";

import { ChatMessage } from "@/components/chat/ChatMessage";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";

import type { ChatTransport } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

type MeshView =
  | { type: "channels" }
  | { type: "broadcast" }
  | { type: "members" }
  | { type: "dm"; peerID: string };

/**
 * Bluetooth mesh chat for nearby bitchat-compatible devices. The first screen
 * mirrors Armada's chat/channel shape, while DMs use native Noise XX sessions.
 */
export function MeshPage() {
  const { user } = useCurrentUser();
  const { transport, mesh, send, sendPrivate } = useMeshTransport();
  const [view, setView] = useState<MeshView>({ type: "channels" });
  const [draft, setDraft] = useState("");

  const selectedPeer = view.type === "dm"
    ? mesh.peers.find((peer) => peer.peerID === view.peerID) ?? null
    : null;

  const directTransport = useMemo<ChatTransport>(
    () => ({
      messages: selectedPeer ? mesh.directMessages[selectedPeer.peerID] ?? [] : [],
      isLoading: transport.isLoading,
      canWrite: mesh.started && !!selectedPeer,
      canModerate: false,
    }),
    [mesh.directMessages, mesh.started, selectedPeer, transport.isLoading],
  );

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const activeTransport = view.type === "dm" ? directTransport : transport;
  const canCompose = view.type === "broadcast" || view.type === "dm";

  const onSend = async () => {
    const content = draft.trim();
    if (!content || !mesh.started || !canCompose) return;
    setDraft("");
    try {
      if (view.type === "dm") {
        if (!selectedPeer) throw new Error("Peer unavailable");
        await sendPrivate(selectedPeer, content);
      } else {
        await send(content);
      }
    } catch {
      // Surface failures by restoring the draft so the user can retry.
      setDraft(content);
    }
  };

  return (
    <div className="flex flex-1 min-h-0">
      <ServerRail />
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        <MeshHeader
          view={view}
          peer={selectedPeer}
          peerCount={mesh.peers.length}
          started={mesh.started}
          onBack={() => setView({ type: "channels" })}
          onMembers={() => setView({ type: "members" })}
        />

        {!mesh.available ? (
          <UnavailableState />
        ) : transport.isLoading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {mesh.error && (
              <div className="mx-3 mt-2 text-xs text-destructive">
                {mesh.error}{" "}
                <button className="underline" onClick={() => void mesh.start()}>
                  Retry
                </button>
              </div>
            )}

            {view.type === "channels" ? (
              <ChannelList
                peerCount={mesh.peers.length}
                started={mesh.started}
                onOpenBroadcast={() => setView({ type: "broadcast" })}
              />
            ) : view.type === "members" ? (
              <MemberList
                peers={mesh.peers}
                onOpenDM={(peerID) => setView({ type: "dm", peerID })}
              />
            ) : (
              <MessageTimeline
                transport={activeTransport}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
                emptyState={view.type === "dm" ? <EmptyDM peer={selectedPeer} /> : <EmptyBroadcast />}
                renderMessage={(msg) => (
                  <ChatMessage
                    key={msg.id}
                    event={msg}
                    canWrite={activeTransport.canWrite}
                    canModerate={false}
                  />
                )}
              />
            )}

            {canCompose && (
              <div className="px-3 pb-3 pt-1 shrink-0">
                <div className="flex items-end gap-2 rounded-2xl bg-secondary/40 px-3 py-1.5">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void onSend();
                      }
                    }}
                    rows={1}
                    placeholder={composerPlaceholder(view, mesh.started, selectedPeer)}
                    disabled={!mesh.started || (view.type === "dm" && !selectedPeer)}
                    className="block w-full resize-none bg-transparent border-0 outline-none px-1 py-2 leading-5 text-base md:text-sm placeholder:text-muted-foreground disabled:opacity-50 max-h-40 overflow-y-auto"
                  />
                  <Button
                    size="icon"
                    aria-label="Send"
                    disabled={!mesh.started || !draft.trim() || (view.type === "dm" && !selectedPeer)}
                    onClick={() => void onSend()}
                    className="size-9 shrink-0"
                  >
                    <Send className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        <div className="px-3 pb-safe shrink-0">
          <LoginArea className="w-full flex" />
        </div>
      </main>
    </div>
  );
}

function MeshHeader({
  view,
  peer,
  peerCount,
  started,
  onBack,
  onMembers,
}: {
  view: MeshView;
  peer: MeshPeer | null;
  peerCount: number;
  started: boolean;
  onBack: () => void;
  onMembers: () => void;
}) {
  const isRoot = view.type === "channels";
  const title = view.type === "dm"
    ? peer?.nickname ?? "Mesh DM"
    : view.type === "members"
      ? "Mesh participants"
      : view.type === "broadcast"
        ? "Nearby mesh"
        : "Mesh";

  return (
    <header className="h-12 mx-2 mt-3 px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
      {!isRoot ? (
        <Button size="icon" variant="ghost" className="size-8" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
      ) : (
        <Radio className="size-5 text-primary" />
      )}
      <h1 className="font-semibold flex-1 min-w-0 truncate">{title}</h1>
      {view.type === "broadcast" && (
        <Button size="sm" variant="ghost" className="gap-1 px-2" onClick={onMembers}>
          <Users className="size-4" />
          <span className="text-xs">{peerCount}</span>
        </Button>
      )}
      {started ? (
        <Bluetooth className="size-4 text-success" />
      ) : (
        <BluetoothOff className="size-4 text-muted-foreground" />
      )}
    </header>
  );
}

function ChannelList({
  peerCount,
  started,
  onOpenBroadcast,
}: {
  peerCount: number;
  started: boolean;
  onOpenBroadcast: () => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4">
      <button
        type="button"
        onClick={onOpenBroadcast}
        className="w-full rounded-2xl bg-secondary/35 hover:bg-secondary/55 transition-colors px-4 py-3 text-left flex items-center gap-3"
      >
        <span className="size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
          <Hash className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Nearby mesh</span>
          <span className="block text-xs text-muted-foreground truncate">
            Broadcast to Armada and bitchat devices in Bluetooth range
          </span>
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-4" />
          {peerCount}
        </span>
      </button>

      <div className="mt-4 rounded-2xl border border-dashed border-border/70 px-4 py-5 text-sm text-muted-foreground">
        {started ? "Tap the channel to chat, or open participants from the chat header to start a mesh DM." : "Starting Bluetooth mesh…"}
      </div>
    </div>
  );
}

function MemberList({ peers, onOpenDM }: { peers: MeshPeer[]; onOpenDM: (peerID: string) => void }) {
  if (peers.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground px-6 text-center">
        <div>
          <Users className="size-10 mx-auto opacity-40 mb-3" />
          <p className="text-sm">No active mesh participants yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Nearby Armada or bitchat devices will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
      {peers.map((peer) => (
        <button
          key={peer.peerID}
          type="button"
          onClick={() => onOpenDM(peer.peerID)}
          className="w-full rounded-2xl bg-secondary/30 hover:bg-secondary/50 transition-colors px-4 py-3 text-left flex items-center gap-3"
        >
          <span className="size-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold">
            {peer.nickname.slice(0, 1).toUpperCase() || "?"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium truncate">{peer.nickname}</span>
            <span className="block text-xs text-muted-foreground truncate">{peer.peerID}</span>
          </span>
          <MessageCircle className="size-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function UnavailableState() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <div className="flex flex-col items-center gap-3 max-w-xs text-center px-6">
        <BluetoothOff className="size-12 opacity-30" />
        <p className="text-sm font-medium">Mesh chat isn't available here</p>
        <p className="text-xs text-muted-foreground/70">
          Nearby Bluetooth chat runs on the Armada Android app, which talks to other devices directly over Bluetooth.
        </p>
      </div>
    </div>
  );
}

function EmptyBroadcast() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Radio className="size-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">No messages nearby yet</p>
      <p className="text-xs text-muted-foreground/60 mt-1">Messages appear when another Armada or bitchat device is in range.</p>
    </div>
  );
}

function EmptyDM({ peer }: { peer: MeshPeer | null }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <MessageCircle className="size-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">No mesh DMs yet</p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        {peer ? `Messages to ${peer.nickname} use bitchat Noise XX encryption.` : "This participant is no longer active."}
      </p>
    </div>
  );
}

function composerPlaceholder(view: MeshView, started: boolean, peer: MeshPeer | null) {
  if (!started) return "Starting mesh…";
  if (view.type === "dm") return peer ? `Message ${peer.nickname}…` : "Participant unavailable";
  return "Message nearby devices…";
}

export default MeshPage;

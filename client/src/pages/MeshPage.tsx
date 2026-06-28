import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Bluetooth,
  BluetoothOff,
  ChevronLeft,
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
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { cn } from "@/lib/utils";

import type { ChatTransport } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

/**
 * What the chat pane is currently showing. `null` is the "nothing selected"
 * landing state (mobile: the sidebar is revealed; desktop: a prompt).
 */
type MeshView =
  | { type: "broadcast" }
  | { type: "dm"; peerID: string }
  | null;

/**
 * Bluetooth mesh chat for nearby bitchat-compatible devices. Mirrors the
 * server/channel shape (`ChannelSidebarView` + `SwipeReveal`) so it reads as a
 * "Mesh" server: a `# nearby mesh` channel for the broadcast room, and a
 * Members roster of nearby peers whose rows open native Noise XX DMs.
 */
export function MeshPage() {
  const { user } = useCurrentUser();
  const { transport, mesh, send, sendPrivate } = useMeshTransport();
  const [view, setView] = useState<MeshView>(null);
  const [draft, setDraft] = useState("");

  // A peer that drops off the roster (left Bluetooth range) shouldn't leave the
  // DM pane pointing at a dead peer — fall back to the landing state.
  useEffect(() => {
    if (view?.type === "dm" && !mesh.peers.some((p) => p.peerID === view.peerID)) {
      setView(null);
    }
  }, [view, mesh.peers]);

  const selectedPeer = view?.type === "dm"
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

  const activeTransport = view?.type === "dm" ? directTransport : transport;

  const onSend = async () => {
    const content = draft.trim();
    if (!content || !mesh.started || !view) return;
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
    <SwipeReveal
      open={view === null}
      onReveal={() => setView(null)}
      onClose={() => setView((v) => v ?? { type: "broadcast" })}
      underlay={
        <>
          <ServerRail onNavigate={() => setView(null)} />
          <MeshSidebar
            view={view}
            available={mesh.available}
            started={mesh.started}
            error={mesh.error}
            peers={mesh.peers}
            peerCount={mesh.peers.length}
            onRetry={() => void mesh.start()}
            onOpenBroadcast={() => setView({ type: "broadcast" })}
            onOpenDM={(peerID) => setView({ type: "dm", peerID })}
            className="flex-1 sidebar:flex-none sidebar:w-60"
          />
        </>
      }
    >
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        {!mesh.available ? (
          <UnavailableState />
        ) : !view ? (
          <SelectState started={mesh.started} />
        ) : (
          <>
            <ChatHeader
              view={view}
              peer={selectedPeer}
              started={mesh.started}
              onBack={() => setView(null)}
            />

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
          </>
        )}
      </main>
    </SwipeReveal>
  );
}

/**
 * The mesh "server" sidebar: a Mesh title, a `# nearby mesh` channel for the
 * broadcast room, and a Members roster of nearby peers (rows open Noise XX
 * DMs). Built on the shared {@link ChannelSidebarView} so it renders the same
 * frame as the NIP-29 channel list and Concord.
 */
function MeshSidebar({
  view,
  available,
  started,
  error,
  peers,
  peerCount,
  onRetry,
  onOpenBroadcast,
  onOpenDM,
  className,
}: {
  view: MeshView;
  available: boolean;
  started: boolean;
  error: string | null;
  peers: MeshPeer[];
  peerCount: number;
  onRetry: () => void;
  onOpenBroadcast: () => void;
  onOpenDM: (peerID: string) => void;
  className?: string;
}) {
  return (
    <ChannelSidebarView
      className={className}
      title="Mesh"
      subtitle={
        available
          ? started
            ? "Nearby · Noise XX encrypted"
            : "Starting Bluetooth mesh…"
          : "Unavailable here"
      }
      addChannelDisabled
      footer={
        <div className="px-3 pb-safe shrink-0">
          <LoginArea className="w-full flex" />
        </div>
      }
    >
      {/* Channels: the single broadcast room. */}
      <ChannelRow
        icon={<Hash className="size-4 shrink-0" />}
        label="nearby mesh"
        active={view?.type === "broadcast"}
        onClick={onOpenBroadcast}
        trailing={
          <span className="flex items-center gap-0.5 text-xs">
            <Users className="size-3.5" />
            {peerCount}
          </span>
        }
      />

      {error && (
        <div className="px-4 py-2 text-xs text-destructive">
          {error}{" "}
          <button className="underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {/* Members: nearby peers. Tapping one opens a native Noise XX DM. */}
      <h3 className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Members{peers.length > 0 ? ` · ${peers.length}` : ""}
      </h3>
      {peers.length === 0 ? (
        <p className="px-4 py-1 text-xs text-muted-foreground/70">
          {available
            ? started
              ? "No nearby devices yet. Armada or bitchat devices in Bluetooth range appear here."
              : "Starting Bluetooth mesh…"
            : "Mesh chat runs on the Armada Android app."}
        </p>
      ) : (
        peers.map((peer) => (
          <MemberRow
            key={peer.peerID}
            peer={peer}
            active={view?.type === "dm" && view.peerID === peer.peerID}
            onClick={() => onOpenDM(peer.peerID)}
          />
        ))
      )}
    </ChannelSidebarView>
  );
}

/** A channel-list row matching `ChannelSidebar`'s `ChannelLink` styling. */
function ChannelRow({
  icon,
  label,
  active,
  onClick,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "gutter-tick w-full flex items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors text-left",
        "text-muted-foreground hover:text-foreground",
        active && "is-active text-foreground font-medium",
      )}
    >
      {icon}
      <span className="truncate flex-1">{label}</span>
      {trailing}
    </button>
  );
}

/** A member roster row (a nearby mesh peer) styled like a channel row. */
function MemberRow({
  peer,
  active,
  onClick,
}: {
  peer: MeshPeer;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "gutter-tick w-full flex items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors text-left",
        "text-muted-foreground hover:text-foreground",
        active && "is-active text-foreground font-medium",
      )}
    >
      <span className="size-6 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[11px] font-semibold">
        {peer.nickname.slice(0, 1).toUpperCase() || "?"}
      </span>
      <span className="truncate flex-1">{peer.nickname}</span>
    </button>
  );
}

/** Chat-pane header (broadcast room or a peer DM). */
function ChatHeader({
  view,
  peer,
  started,
  onBack,
}: {
  view: NonNullable<MeshView>;
  peer: MeshPeer | null;
  started: boolean;
  onBack: () => void;
}) {
  const isDm = view.type === "dm";
  const title = isDm ? peer?.nickname ?? "Mesh DM" : "nearby mesh";

  return (
    <header className="relative h-12 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
      {/* Mobile back → slides the chat away to reveal the mesh sidebar. */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Back to mesh"
        className="size-9 shrink-0 sidebar:hidden"
        onClick={onBack}
      >
        <ChevronLeft className="size-5" />
      </Button>
      {isDm ? (
        <span className="size-7 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
          {peer?.nickname.slice(0, 1).toUpperCase() || <MessageCircle className="size-4" />}
        </span>
      ) : (
        <Hash className="size-5 text-muted-foreground shrink-0" />
      )}
      <h1 className="font-semibold truncate flex-1 min-w-0">{title}</h1>
      {started ? (
        <Bluetooth className="size-4 text-success shrink-0" />
      ) : (
        <BluetoothOff className="size-4 text-muted-foreground shrink-0" />
      )}
    </header>
  );
}

function SelectState({ started }: { started: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground p-8 text-center">
      <div className="flex flex-col items-center gap-3 max-w-sm">
        {started ? (
          <Radio className="size-12 opacity-30" />
        ) : (
          <Loader2 className="size-10 animate-spin opacity-40" />
        )}
        <p className="text-sm">
          {started ? "Open #nearby mesh, or pick a participant to start a DM" : "Starting Bluetooth mesh…"}
        </p>
      </div>
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

function composerPlaceholder(view: NonNullable<MeshView>, started: boolean, peer: MeshPeer | null) {
  if (!started) return "Starting mesh…";
  if (view.type === "dm") return peer ? `Message ${peer.nickname}…` : "Participant unavailable";
  return "Message nearby devices…";
}

export default MeshPage;

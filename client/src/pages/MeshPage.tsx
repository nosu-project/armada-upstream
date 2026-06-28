import { useState } from "react";
import { Navigate } from "react-router-dom";
import { Bluetooth, BluetoothOff, Loader2, Radio, Send, Users } from "lucide-react";

import { ChatMessage } from "@/components/chat/ChatMessage";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";

/**
 * Bluetooth mesh chat: a single public room of nearby devices, carried over BLE
 * by the vendored bitchat mesh (Android only). It sits above DMs in the rail.
 *
 * The mesh is offline/peer-to-peer — no relay, no internet — so this surface is
 * available only on the Android app (BLE advertise + scan + background service).
 * On web/desktop it shows an "unavailable here" state.
 */
export function MeshPage() {
  const { user } = useCurrentUser();
  const { transport, mesh, send } = useMeshTransport();
  const [draft, setDraft] = useState("");

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const onSend = async () => {
    const content = draft.trim();
    if (!content || !mesh.started) return;
    setDraft("");
    try {
      await send(content);
    } catch {
      // Surface failures by restoring the draft so the user can retry.
      setDraft(content);
    }
  };

  return (
    <div className="flex flex-1 min-h-0">
      <ServerRail />
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        <header className="h-12 mx-2 mt-3 px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
          <Radio className="size-5 text-primary" />
          <h1 className="font-semibold flex-1 min-w-0 truncate">Nearby mesh</h1>
          {mesh.started && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="size-4" />
              {mesh.peers.length}
            </span>
          )}
          {mesh.started ? (
            <Bluetooth className="size-4 text-success" />
          ) : (
            <BluetoothOff className="size-4 text-muted-foreground" />
          )}
        </header>

        {!mesh.available ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3 max-w-xs text-center px-6">
              <BluetoothOff className="size-12 opacity-30" />
              <p className="text-sm font-medium">Mesh chat isn't available here</p>
              <p className="text-xs text-muted-foreground/70">
                Nearby Bluetooth chat runs on the Armada Android app, which talks
                to other devices directly over Bluetooth — no relay or internet.
              </p>
            </div>
          </div>
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
            <MessageTimeline
              transport={transport}
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
              emptyState={
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Radio className="size-10 text-muted-foreground/40 mb-3" />
                  <p className="text-sm text-muted-foreground">No one nearby yet</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Messages appear when another Armada (or bitchat) device is in range.
                  </p>
                </div>
              }
              renderMessage={(msg) => (
                <ChatMessage
                  key={msg.id}
                  event={msg}
                  canWrite={transport.canWrite}
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
                  placeholder={mesh.started ? "Message nearby devices…" : "Starting mesh…"}
                  disabled={!mesh.started}
                  className="block w-full resize-none bg-transparent border-0 outline-none px-1 py-2 leading-5 text-base md:text-sm placeholder:text-muted-foreground disabled:opacity-50 max-h-40 overflow-y-auto"
                />
                <Button
                  size="icon"
                  aria-label="Send"
                  disabled={!mesh.started || !draft.trim()}
                  onClick={() => void onSend()}
                  className="size-9 shrink-0"
                >
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}

        <div className="px-3 pb-safe shrink-0">
          <LoginArea className="w-full flex" />
        </div>
      </main>
    </div>
  );
}

export default MeshPage;

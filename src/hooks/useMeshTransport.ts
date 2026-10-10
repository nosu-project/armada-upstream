import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { MeshContext, type MeshContextType, type MeshState } from "@/contexts/MeshContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUserProfile } from "@/hooks/useCurrentUser";
import { BluetoothMesh, type MeshMessage, type MeshPeer } from "@/lib/bluetoothMesh";
import { meshAnonName } from "@/lib/meshIdentity";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

export type { MeshState } from "@/contexts/MeshContext";

/** Synthetic kind for adapted mesh messages (mirrors NIP-29 chat kind 9). */
const MESH_KIND = 9;

/**
 * Adapt a mesh message to `ChatMsg`. `pubkey` holds the mesh peer id (not a Nostr key) as a
 * stable author key.
 */
function meshToEvent(m: MeshMessage): ChatMsg {
  return {
    id: m.id,
    pubkey: m.senderPeerID ?? m.sender,
    created_at: Math.floor((m.timestamp || Date.now()) / 1000),
    kind: MESH_KIND,
    tags: [["mesh_sender", m.sender]],
    content: m.content,
  };
}

/**
 * Android Bluetooth mesh as a {@link ChatTransport}; public broadcast chat only. Mounted ONCE
 * in {@link MeshProvider} so history survives navigation (native has no replay). UI code should
 * use {@link useMeshTransport}.
 */
export function useMeshTransportState(): MeshContextType {
  const { user, metadata } = useCurrentUserProfile();
  const { config, updateConfig } = useAppContext();
  const incognito = config.meshIncognito;
  // Opt-in: no permission prompt or foreground service until the user enables it.
  const enabled = config.meshEnabled;
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [directMessages, setDirectMessages] = useState<Record<string, ChatMsg[]>>({});
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [available, setAvailable] = useState(false);
  const [started, setStarted] = useState(false);
  const [myPeerID, setMyPeerID] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const realName = useMemo(() => {
    return (
      metadata?.display_name?.trim() ||
      metadata?.name?.trim() ||
      (user ? `armada-${user.pubkey.slice(0, 8)}` : "")
    );
  }, [metadata?.display_name, metadata?.name, user]);

  // Incognito → `anon<peerid>` (blank until our peer id is known; native keeps its default).
  const myNickname = useMemo(() => {
    if (incognito) return myPeerID ? meshAnonName(myPeerID) : "";
    return realName;
  }, [incognito, myPeerID, realName]);

  const setIncognito = useCallback(
    (next: boolean) => updateConfig((c) => ({ ...c, meshIncognito: next })),
    [updateConfig],
  );

  // The mesh floods, so the same packet can surface more than once.
  const seenIds = useRef<Set<string>>(new Set());
  const seenPrivateIds = useRef<Set<string>>(new Set());
  const appendMessage = useCallback((m: MeshMessage) => {
    if (m.isPrivate) {
      const peerID = m.senderPeerID;
      if (!peerID || seenPrivateIds.current.has(m.id)) return;
      seenPrivateIds.current.add(m.id);
      setDirectMessages((prev) => {
        const nextMessages = [...(prev[peerID] ?? []), meshToEvent(m)];
        nextMessages.sort((a, b) => a.created_at - b.created_at);
        return { ...prev, [peerID]: nextMessages };
      });
      return;
    }
    if (seenIds.current.has(m.id)) return;
    seenIds.current.add(m.id);
    setMessages((prev) => {
      const next = [...prev, meshToEvent(m)];
      next.sort((a, b) => a.created_at - b.created_at);
      return next;
    });
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      // Incognito's anon name needs the peer id; the sync effect below announces it later.
      if (myNickname) await BluetoothMesh.setNickname({ nickname: myNickname });
      const { peerID } = await BluetoothMesh.start();
      setMyPeerID(peerID);
      setStarted(true);
      try {
        const { peers: p } = await BluetoothMesh.getPeers();
        setPeers(p);
      } catch { /* roster arrives via the "peers" event too */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarted(false);
    }
  }, [myNickname]);

  const stop = useCallback(async () => {
    try {
      await BluetoothMesh.stop();
    } finally {
      setStarted(false);
      setError(null);
    }
  }, []);

  const setEnabled = useCallback(
    (next: boolean) => {
      updateConfig((c) => ({ ...c, meshEnabled: next }));
      if (!next) void stop().catch(() => undefined);
    },
    [updateConfig, stop],
  );

  useEffect(() => {
    let cancelled = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    (async () => {
      try {
        const { available: avail } = await BluetoothMesh.isAvailable();
        if (cancelled) return;
        setAvailable(avail);
        if (avail) {
          // A handle that resolves after cleanup ran would never be removed.
          const onMessage = await BluetoothMesh.addListener("message", appendMessage);
          if (cancelled) { void onMessage.remove(); return; }
          handles.push(onMessage);
          const onPeers = await BluetoothMesh.addListener("peers", (d) => setPeers(d.peers));
          if (cancelled) { void onPeers.remove(); return; }
          handles.push(onPeers);
        }
      } catch {
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      for (const h of handles) void h.remove();
    };
  }, [appendMessage]);

  // Wait for the real name (unless incognito) so we never announce a blank. `enabled` is the
  // consent gate.
  useEffect(() => {
    if (enabled && available && !started && (incognito || realName)) void start();
    // Only react to enablement/availability/name readiness; `start` is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, available, incognito, realName]);

  useEffect(() => {
    if (started && myNickname) void BluetoothMesh.setNickname({ nickname: myNickname }).catch(() => {});
  }, [started, myNickname]);

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      // The mesh does not loop our own messages back.
      appendMessage({
        id: `local-${crypto.randomUUID()}`.toUpperCase(),
        sender: myNickname || "me",
        content: trimmed,
        timestamp: Date.now(),
        senderPeerID: myPeerID,
        channel: null,
        isPrivate: false,
      });
      await BluetoothMesh.sendMessage({ content: trimmed });
    },
    [appendMessage, myNickname, myPeerID],
  );

  const sendPrivate = useCallback(
    async (peer: MeshPeer, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const messageID = crypto.randomUUID().toUpperCase();
      const now = Date.now();
      const localMessage = meshToEvent({
        id: messageID,
        sender: myNickname || "me",
        content: trimmed,
        timestamp: now,
        senderPeerID: myPeerID,
        channel: null,
        isPrivate: true,
      });
      setDirectMessages((prev) => {
        const nextMessages = [...(prev[peer.peerID] ?? []), localMessage];
        nextMessages.sort((a, b) => a.created_at - b.created_at);
        return { ...prev, [peer.peerID]: nextMessages };
      });
      await BluetoothMesh.sendPrivateMessage({
        content: trimmed,
        peerID: peer.peerID,
        nickname: peer.nickname,
        messageID,
      });
    },
    [myPeerID, myNickname],
  );

  const transport = useMemo<ChatTransport>(
    () => ({
      messages,
      isLoading,
      canWrite: started,
      canModerate: false,
    }),
    [messages, isLoading, started],
  );

  const mesh = useMemo<MeshState>(
    () => ({
      available, probing: isLoading, enabled, started, myPeerID, peers, directMessages, error,
      incognito, myNickname, start, stop, setEnabled, setIncognito,
    }),
    [available, isLoading, enabled, started, myPeerID, peers, directMessages, error, incognito, myNickname, start, stop, setEnabled, setIncognito],
  );

  return useMemo(
    () => ({ transport, mesh, send, sendPrivate }),
    [transport, mesh, send, sendPrivate],
  );
}

/** Throws outside {@link MeshProvider}. */
export function useMeshTransport(): MeshContextType {
  const ctx = useContext(MeshContext);
  if (!ctx) {
    throw new Error("useMeshTransport must be used within a MeshProvider");
  }
  return ctx;
}

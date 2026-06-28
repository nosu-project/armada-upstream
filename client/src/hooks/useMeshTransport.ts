import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { BluetoothMesh, type MeshMessage, type MeshPeer } from "@/lib/bluetoothMesh";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";

/** Synthetic Nostr kind for adapted mesh messages (mirrors NIP-29 chat kind 9). */
const MESH_KIND = 9;

/**
 * Adapt a mesh wire message to the shared `ChatMsg` (NostrEvent) shape so it
 * renders through the SAME `ChatMessage`/`ChatContent` path as NIP-29 and
 * Concord. Mesh peers are NOT Nostr pubkeys, so `pubkey` carries the mesh peer
 * id (or sender nickname) purely as a stable author key; rendering never
 * re-verifies the (empty) signature.
 */
function meshToEvent(m: MeshMessage): ChatMsg {
  return {
    id: m.id,
    pubkey: m.senderPeerID ?? m.sender,
    created_at: Math.floor((m.timestamp || Date.now()) / 1000),
    kind: MESH_KIND,
    tags: [["mesh_sender", m.sender]],
    content: m.content,
    sig: "",
  };
}

export interface MeshState {
  /** Whether the platform can run the BLE mesh (Android only). */
  available: boolean;
  /** Whether the mesh is currently running. */
  started: boolean;
  /** This device's mesh peer id, once started. */
  myPeerID: string | null;
  /** Current peer roster. */
  peers: MeshPeer[];
  /** Direct-message histories keyed by mesh peer id. */
  directMessages: Record<string, ChatMsg[]>;
  /** A startup/permission error, if any. */
  error: string | null;
  /** Manually (re)start the mesh (e.g. after granting permission). */
  start: () => Promise<void>;
  /** Stop the mesh. */
  stop: () => Promise<void>;
}

/**
 * Drives the Android Bluetooth mesh and exposes it as a {@link ChatTransport}
 * for the shared chat UI. Public (broadcast) mesh chat only in this first cut —
 * a single room of nearby devices. Channels/DMs/reactions/threads are omitted,
 * so the shared components hide those controls automatically.
 *
 * Identity: the mesh keeps its native crypto identity; we only push the
 * logged-in Nostr profile name down as the announced nickname.
 */
export function useMeshTransport(): {
  transport: ChatTransport;
  mesh: MeshState;
  send: (content: string) => Promise<void>;
  sendPrivate: (peer: MeshPeer, content: string) => Promise<void>;
} {
  const { user, metadata } = useCurrentUser();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [directMessages, setDirectMessages] = useState<Record<string, ChatMsg[]>>({});
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [available, setAvailable] = useState(false);
  const [started, setStarted] = useState(false);
  const [myPeerID, setMyPeerID] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Preferred announce nickname: profile display name → name → npub-ish fallback.
  const nickname = useMemo(() => {
    return (
      metadata?.display_name?.trim() ||
      metadata?.name?.trim() ||
      (user ? `armada-${user.pubkey.slice(0, 8)}` : "")
    );
  }, [metadata?.display_name, metadata?.name, user]);

  // De-dupe incoming messages by id (the mesh floods, so the same packet can
  // surface more than once) and keep ascending (oldest-first) order.
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
      if (nickname) await BluetoothMesh.setNickname({ nickname });
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
  }, [nickname]);

  const stop = useCallback(async () => {
    try {
      await BluetoothMesh.stop();
    } finally {
      setStarted(false);
    }
  }, []);

  // Probe availability + wire listeners once.
  useEffect(() => {
    let cancelled = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    (async () => {
      try {
        const { available: avail } = await BluetoothMesh.isAvailable();
        if (cancelled) return;
        setAvailable(avail);
        if (avail) {
          handles.push(await BluetoothMesh.addListener("message", appendMessage));
          handles.push(
            await BluetoothMesh.addListener("peers", (d) => setPeers(d.peers)),
          );
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

  // Auto-start once available and we have a nickname to announce.
  useEffect(() => {
    if (available && !started && nickname) void start();
    // Only react to availability/nickname becoming ready; `start` is stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, nickname]);

  // Keep the announced nickname in sync if the profile name changes mid-session.
  useEffect(() => {
    if (started && nickname) void BluetoothMesh.setNickname({ nickname }).catch(() => {});
  }, [started, nickname]);

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      // Optimistic local echo (the mesh does not loop our own messages back).
      appendMessage({
        id: `local-${crypto.randomUUID()}`.toUpperCase(),
        sender: nickname || "me",
        content: trimmed,
        timestamp: Date.now(),
        senderPeerID: myPeerID,
        channel: null,
        isPrivate: false,
      });
      await BluetoothMesh.sendMessage({ content: trimmed });
    },
    [appendMessage, nickname, myPeerID],
  );

  const sendPrivate = useCallback(
    async (peer: MeshPeer, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const messageID = crypto.randomUUID().toUpperCase();
      const now = Date.now();
      const localMessage = meshToEvent({
        id: messageID,
        sender: nickname || "me",
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
    [myPeerID, nickname],
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
    () => ({ available, started, myPeerID, peers, directMessages, error, start, stop }),
    [available, started, myPeerID, peers, directMessages, error, start, stop],
  );

  return { transport, mesh, send, sendPrivate };
}

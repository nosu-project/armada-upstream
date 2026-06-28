import { useCallback, useMemo, useRef } from "react";

import { toChatMsg } from "@/components/chat/transport";
import { KIND_DM, useDirectMessages } from "@/hooks/useDirectMessages";

import type { ChatMsg, ChatTransport, SendStatus } from "@/components/chat/transport";
import type { DecryptedDM } from "@/hooks/useDirectMessages";

/**
 * Build a {@link ChatTransport} for a 1:1 DM thread, so DMs render through the
 * same `MessageTimeline` / `ChatMessage` path as NIP-29 groups and Concord
 * communities instead of a bespoke timeline.
 *
 * DMs are a deliberately minimal transport: NIP-04 has no in-band convention
 * for reactions, replies, edits, pins or threads, so those capabilities are
 * omitted (the shared components hide their controls). What DMs DO have —
 * optimistic send-status with retry, and scroll-up backfill — is wired here.
 *
 * Two DM-specific concerns the shared timeline can't model are surfaced
 * alongside the transport for the page's `renderMessage` to handle:
 *   - `encryptedIds`: ids whose plaintext hasn't been decrypted yet (rendered
 *     as a placeholder row that decrypts when scrolled into view).
 *   - `decryptVisible`: decrypt a placeholder by id (driven by the page's
 *     IntersectionObserver).
 */
export function useDmTransport(peer: string): {
  transport: ChatTransport;
  /** Ids of messages still awaiting lazy decryption (placeholder rows). */
  encryptedIds: Set<string>;
  /** Decrypt a placeholder message by id (on scroll into view). */
  decryptVisible: (id: string) => void;
  /** Sign + optimistically send a DM; resolves once rendered (relay in bg). */
  send: (text: string) => Promise<void>;
} {
  const { messages, isLoading, send, retry, loadOlder, hasMore, isLoadingOlder, decryptVisible } =
    useDirectMessages(peer);

  // Adapt DecryptedDM → ChatMsg, preserving object identity for unchanged
  // messages so React.memo on the rows holds (a fresh array lands on every
  // poll/decrypt). Key the cache on content + status, the only fields that
  // affect the rendered row.
  const adaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const chatMessages = useMemo<ChatMsg[]>(() => {
    const cache = adaptCache.current;
    const next = new Map<string, { sig: string; msg: ChatMsg }>();
    const out = messages.map((m: DecryptedDM) => {
      const sig = `${m.created_at}\u0000${m.content}\u0000${m.status ?? ""}\u0000${m.encrypted ? "1" : "0"}`;
      const hit = cache.get(m.id);
      const entry =
        hit && hit.sig === sig
          ? hit
          : {
              sig,
              msg: toChatMsg({
                id: m.id,
                pubkey: m.pubkey,
                created_at: m.created_at,
                kind: KIND_DM,
                content: m.content,
              }),
            };
      next.set(m.id, entry);
      return entry.msg;
    });
    adaptCache.current = next;
    return out;
  }, [messages]);

  const encryptedIds = useMemo(
    () => new Set(messages.filter((m) => m.encrypted).map((m) => m.id)),
    [messages],
  );

  // Optimistic send status, read off each message's embedded `status`
  // ("sending"/"failed"), mapped to the shared SendStatus ("pending"/"failed").
  const statusById = useMemo(() => {
    const out = new Map<string, SendStatus>();
    for (const m of messages) {
      if (m.status === "sending") out.set(m.id, "pending");
      else if (m.status === "failed") out.set(m.id, "failed");
    }
    return out;
  }, [messages]);

  const sendStatusFor = useCallback((id: string) => statusById.get(id), [statusById]);

  const retryById = useCallback((event: ChatMsg) => retry(event.id), [retry]);

  const sendText = useCallback(
    async (text: string) => {
      await send(text);
    },
    [send],
  );

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: chatMessages,
      isLoading,
      canWrite: true,
      canModerate: false,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor,
      retry: retryById,
    }),
    [chatMessages, isLoading, loadOlder, hasMore, isLoadingOlder, sendStatusFor, retryById],
  );

  return { transport, encryptedIds, decryptVisible, send: sendText };
}

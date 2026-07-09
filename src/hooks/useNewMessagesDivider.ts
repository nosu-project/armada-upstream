import { useRef } from "react";

import { useReadState } from "@/hooks/useReadState";

import type { ChatMsg } from "@/components/chat/transport";

/**
 * Computes where the red "NEW" unread divider belongs for a conversation: the
 * id of the oldest message that arrived after the user last read it.
 *
 * The last-read timestamp is captured synchronously on the first render for a
 * given `readKey` — *before* the mark-read effect stamps the channel as read —
 * and the divider is then frozen for the rest of the visit (Discord behavior:
 * the marker stays put while you read, and clears when you come back later).
 * Messages arriving while the channel is open never spawn a divider, and the
 * user's own messages never count as unread.
 *
 * Returns the message id to render the divider above, or `undefined`.
 */
export function useNewMessagesDivider(
  readKey: string,
  messages: ChatMsg[],
  selfPubkey?: string,
): string | undefined {
  const { getLastRead } = useReadState();

  const stateRef = useRef<{
    key: string;
    lastRead: number;
    dividerId?: string;
    settled: boolean;
  } | null>(null);

  // New conversation: capture the pre-visit last-read stamp before any
  // mark-read effect can bump it.
  if (!stateRef.current || stateRef.current.key !== readKey) {
    stateRef.current = { key: readKey, lastRead: getLastRead(readKey), settled: false };
  }

  const state = stateRef.current;

  // Settle once, on the first render with history present. A never-read
  // conversation (lastRead 0) shows no divider — flagging the entire history
  // of a just-joined channel as "new" is noise, not signal.
  if (!state.settled && messages.length > 0) {
    state.settled = true;
    if (state.lastRead > 0) {
      state.dividerId = messages.find(
        (m) => m.created_at > state.lastRead && m.pubkey !== selfPubkey,
      )?.id;
    }
  }

  return state.dividerId;
}

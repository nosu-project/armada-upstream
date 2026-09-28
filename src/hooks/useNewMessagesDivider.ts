import { useRef } from "react";

import { useReadState } from "@/hooks/useReadState";

export interface ReadableTimelineEntry {
  id: string;
  createdAt: number;
  author: string;
}

/**
 * Where the "NEW" divider belongs: the oldest message after last read. The last-read stamp is
 * captured on the first render per `readKey` (before mark-read) and frozen for the visit. Own
 * messages never count.
 */
export function useNewMessagesDivider(
  readKey: string,
  messages: readonly ReadableTimelineEntry[],
  selfPubkey?: string,
): string | undefined {
  const { getLastRead } = useReadState();

  const stateRef = useRef<{
    key: string;
    lastRead: number;
    dividerId?: string;
    settled: boolean;
  } | null>(null);

  // Capture before any mark-read effect bumps it.
  if (!stateRef.current || stateRef.current.key !== readKey) {
    stateRef.current = { key: readKey, lastRead: getLastRead(readKey), settled: false };
  }

  const state = stateRef.current;

  // A never-read conversation shows no divider.
  if (!state.settled && messages.length > 0) {
    state.settled = true;
    if (state.lastRead > 0) {
      state.dividerId = messages.find(
        (m) => m.createdAt > state.lastRead && m.author !== selfPubkey,
      )?.id;
    }
  }

  return state.dividerId;
}

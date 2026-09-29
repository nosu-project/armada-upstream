import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { missingReplyIds } from "@/components/chat/replyParents";
import { toChatMsg, type ChatMsg } from "@/components/chat/transport";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { queryDm17Messages } from "@/lib/nip17/dm17Store";
import { STORE_READ } from "@/lib/storeQuery";
import type { OpenedDm } from "@/lib/nip17/protocol";

const EMPTY = new Map<string, ChatMsg>();

/** Inline-reply parents in a NIP-17 conversation that fell outside the loaded window, read from the local store. */
export function useDmReplyParents<M extends { id: string }>(
  conversation: string,
  peers: readonly string[],
  messages: readonly M[],
  loaded: ReadonlyMap<string, unknown>,
  replyIdOf: (message: M) => string | undefined,
): ReadonlyMap<string, ChatMsg> {
  const self = useCurrentUser().user?.pubkey;
  const missing = useMemo(
    () => missingReplyIds(messages, loaded, replyIdOf),
    [messages, loaded, replyIdOf],
  );

  const query = useQuery<OpenedDm[]>({
    ...STORE_READ,
    queryKey: ["dm17", "reply-parents", self ?? null, conversation, missing.join(",")],
    enabled: Boolean(self && peers.length > 0 && missing.length > 0),
    staleTime: 30_000,
    // Keep resolved parents painted while a grown window re-keys the read.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === self && prevQuery?.queryKey[3] === conversation ? prev : undefined,
    queryFn: ({ signal }) => queryDm17Messages(self!, peers, missing, { signal }),
  });

  return useMemo(() => {
    const rows = query.data;
    if (!rows || rows.length === 0) return EMPTY;
    const out = new Map<string, ChatMsg>();
    for (const r of rows) {
      out.set(
        r.rumorId,
        toChatMsg({ id: r.rumorId, pubkey: r.author, created_at: r.createdAt, kind: r.kind, content: r.content, tags: r.tags }),
      );
    }
    return out;
  }, [query.data]);
}

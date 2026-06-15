import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { PLATFORM_RELAYS } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-04 encrypted direct message kind. */
export const KIND_DM = 4;

/**
 * The relay DMs live on. DMs are stored on the Armada platform relay, which
 * enforces NIP-42 auth and the participant-only read guard (see server/
 * unmanaged.go). The first platform relay is the home relay.
 */
export function dmRelay(): string {
  return PLATFORM_RELAYS[0];
}

/** The other participant of a DM event, from the viewer's perspective. */
export function dmCounterparty(event: NostrEvent, self: string): string | undefined {
  if (event.pubkey !== self) return event.pubkey; // received: peer is the sender
  // sent: peer is the first `p` tag
  return event.tags.find(([name]) => name === "p")?.[1];
}

/** A decrypted DM ready for rendering. */
export interface DecryptedDM {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
}

/** Whether the current signer can do NIP-04 (required for DMs). */
export function useDMSupport(): boolean {
  const { user } = useCurrentUser();
  return !!user?.signer.nip04;
}

/**
 * The list of DM conversations for the current user: every distinct
 * counterparty with the latest message and its timestamp. Built client-side
 * from kind-4 events on the DM relay (no caching service, unlike Primal).
 */
export function useDMConversations() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const relayUrl = dmRelay();

  const queryKey = ["dm", "conversations", user?.pubkey];

  const query = useQuery<NostrEvent[]>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;
      const events = await nostr.relay(relayUrl).query(
        [
          { kinds: [KIND_DM], authors: [pubkey], limit: 500 },
          { kinds: [KIND_DM], "#p": [pubkey], limit: 500 },
        ],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return events;
    },
    staleTime: 15_000,
  });

  // Live subscription so new conversations/messages surface without a refetch.
  useEffect(() => {
    if (!user?.pubkey) return;
    const pubkey = user.pubkey;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [
            { kinds: [KIND_DM], authors: [pubkey], since },
            { kinds: [KIND_DM], "#p": [pubkey], since },
          ],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            queryClient.setQueryData<NostrEvent[]>(queryKey, (old = []) =>
              old.some((e) => e.id === event.id) ? old : [...old, event],
            );
          }
        }
      } catch {
        // subscription closed
      }
    })();

    return () => controller.abort();
    // queryKey is derived from user.pubkey; relayUrl is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, relayUrl, queryClient]);

  const self = user?.pubkey ?? "";

  // Reduce raw events to one entry per counterparty (latest wins).
  const conversations = (() => {
    const byPeer = new Map<string, { peer: string; latest: NostrEvent }>();
    for (const event of query.data ?? []) {
      const peer = dmCounterparty(event, self);
      if (!peer) continue;
      const existing = byPeer.get(peer);
      if (!existing || event.created_at > existing.latest.created_at) {
        byPeer.set(peer, { peer, latest: event });
      }
    }
    return [...byPeer.values()].sort((a, b) => b.latest.created_at - a.latest.created_at);
  })();

  return { conversations, isLoading: query.isLoading, error: query.error };
}

/**
 * The decrypted message thread with a single peer, plus a `send` mutation.
 * Messages are kind-4 NIP-04 events on the DM relay, decrypted with the
 * signer's nip04 method.
 */
export function useDirectMessages(peer: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const relayUrl = dmRelay();

  const self = user?.pubkey;
  const queryKey = ["dm", "thread", self, peer];

  const query = useQuery<DecryptedDM[]>({
    queryKey,
    enabled: !!self && !!peer && !!user?.signer.nip04,
    queryFn: async ({ signal }) => {
      const nip04 = user!.signer.nip04!;
      // Both directions of the conversation.
      const events = await nostr.relay(relayUrl).query(
        [
          { kinds: [KIND_DM], authors: [self!], "#p": [peer!] },
          { kinds: [KIND_DM], authors: [peer!], "#p": [self!] },
        ],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      const decrypted = await Promise.all(
        events.map(async (event): Promise<DecryptedDM | null> => {
          const counterparty = event.pubkey === self ? peer! : event.pubkey;
          try {
            const content = await nip04.decrypt(counterparty, event.content);
            return { id: event.id, pubkey: event.pubkey, created_at: event.created_at, content };
          } catch {
            return null; // undecryptable (e.g. not actually for us) — drop
          }
        }),
      );

      return decrypted
        .filter((m): m is DecryptedDM => m !== null)
        .sort((a, b) => a.created_at - b.created_at);
    },
    staleTime: 10_000,
  });

  // Live subscription for new messages in this thread.
  useEffect(() => {
    if (!self || !peer || !user?.signer.nip04) return;
    const nip04 = user.signer.nip04;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [
            { kinds: [KIND_DM], authors: [self], "#p": [peer], since },
            { kinds: [KIND_DM], authors: [peer], "#p": [self], since },
          ],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrEvent;
          const counterparty = event.pubkey === self ? peer : event.pubkey;
          let content: string;
          try {
            content = await nip04.decrypt(counterparty, event.content);
          } catch {
            continue;
          }
          const decrypted: DecryptedDM = {
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            content,
          };
          queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
            old.some((m) => m.id === decrypted.id)
              ? old
              : [...old, decrypted].sort((a, b) => a.created_at - b.created_at),
          );
        }
      } catch {
        // subscription closed
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, self, peer, user?.signer.nip04, relayUrl, queryClient]);

  const send = useMutation({
    mutationFn: async (text: string) => {
      if (!user?.signer.nip04) throw new Error("NIP-04 encryption not supported by signer");
      if (!peer) throw new Error("No recipient");
      const trimmed = text.trim();
      if (!trimmed) return;

      const content = await user.signer.nip04.encrypt(peer, trimmed);
      const event = await user.signer.signEvent({
        kind: KIND_DM,
        content,
        tags: [["p", peer]],
        created_at: Math.floor(Date.now() / 1000),
      });

      await nostr.relay(relayUrl).event(event, { signal: AbortSignal.timeout(8000) });

      // Optimistically render the sent message.
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
        old.some((m) => m.id === event.id)
          ? old
          : [
              ...old,
              { id: event.id, pubkey: user.pubkey, created_at: event.created_at, content: trimmed },
            ].sort((a, b) => a.created_at - b.created_at),
      );
      // Refresh the conversation list ordering.
      queryClient.invalidateQueries({ queryKey: ["dm", "conversations", user.pubkey] });
    },
  });

  return {
    messages: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    send: send.mutateAsync,
    isSending: send.isPending,
  };
}

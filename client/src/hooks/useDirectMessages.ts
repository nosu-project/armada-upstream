import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { effectiveDmRelays } from "@/contexts/AppContext";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-04 encrypted direct message kind. */
export const KIND_DM = 4;

/**
 * Per-pubkey serialization of signer crypto (encrypt / signEvent / decrypt).
 *
 * NIP-07 browser extensions process these one at a time and **reject** (or
 * queue unpredictably) overlapping calls. The DM data layer fires crypto from
 * several places concurrently — sending, the thread decrypt loop, the live
 * subscription, and the conversation-list previews. If those overlap on the
 * extension they thrash, reject, and feel "locked up". Routing every signer
 * crypto call for a given identity through one promise chain keeps them
 * strictly sequential (and fast on a local nsec, where there's no contention).
 *
 * Keyed at module scope by pubkey so the chain is shared across every hook
 * instance and survives remounts.
 */
const signerCryptoChains = new Map<string, Promise<unknown>>();

/** Run `fn` exclusively against the signer identified by `key` (FIFO). */
function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = signerCryptoChains.get(key) ?? Promise.resolve();
  // Chain off the prior call regardless of whether it resolved or rejected,
  // so one failure never wedges the queue.
  const next = prior.then(fn, fn);
  // Store a settled-swallowing tail so the stored promise never rejects
  // (which would otherwise reject every future `.then` chained onto it).
  signerCryptoChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
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
  /**
   * Delivery state for messages we sent. Absent for received messages and for
   * sent messages that have been confirmed by the relay. `"sending"` while the
   * publish is in flight (rendered immediately on sign), `"failed"` if the
   * relay rejected it or the publish timed out (retryable).
   */
  status?: "sending" | "failed";
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
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");

  const queryKey = ["dm", "conversations", user?.pubkey, relayKey];

  const query = useQuery<NostrEvent[]>({
    queryKey,
    enabled: !!user?.pubkey,
    queryFn: async ({ signal }) => {
      const pubkey = user!.pubkey;
      const events = await nostr.group(relays).query(
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

  // Cache-first seed: hydrate the conversation list from IndexedDB so it
  // survives a refresh and renders before the network resolves.
  useEffect(() => {
    if (!user?.pubkey) return;
    const pubkey = user.pubkey;
    let cancelled = false;
    void (async () => {
      if ((queryClient.getQueryData<NostrEvent[]>(queryKey) ?? []).length > 0) return;
      const store = await eventStore;
      const events = await store.query([
        { kinds: [KIND_DM], authors: [pubkey], limit: 500 },
        { kinds: [KIND_DM], "#p": [pubkey], limit: 500 },
      ]);
      if (cancelled || events.length === 0) return;
      queryClient.setQueryData<NostrEvent[]>(queryKey, (old) =>
        old && old.length > 0 ? old : events,
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, eventStore, queryClient, relayKey]);

  // Live subscription so new conversations/messages surface without a refetch.
  useEffect(() => {
    if (!user?.pubkey) return;
    const pubkey = user.pubkey;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    (async () => {
      try {
        for await (const msg of nostr.group(relays).req(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, relayKey, queryClient]);

  const self = user?.pubkey ?? "";

  // Reduce raw events to one entry per counterparty (latest wins).
  const conversations = useMemo(() => {
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
  }, [query.data, self]);

  // Decrypt just the latest message of each conversation for the list preview.
  // Sequential decrypt (see thread loop) to avoid NIP-07 concurrency rejections.
  const previewKey = conversations
    .map((c) => `${c.peer}:${c.latest.id}`)
    .join(",");

  const previews = useQuery<Record<string, string>>({
    queryKey: ["dm", "previews", self, previewKey],
    enabled: !!self && !!user?.signer.nip04 && conversations.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const nip04 = user!.signer.nip04!;
      const out: Record<string, string> = {};
      for (const { peer, latest } of conversations) {
        try {
          out[peer] = await runExclusive(self, () => nip04.decrypt(peer, latest.content));
        } catch (err) {
          console.warn("DM preview decrypt failed", { peer, id: latest.id, err });
        }
      }
      return out;
    },
  });

  return {
    conversations,
    previews: previews.data ?? {},
    isLoading: query.isLoading,
    error: query.error,
  };
}

/**
 * Whether the user has any unread direct messages — the latest message in any
 * conversation is from the peer and newer than the thread's last-read stamp.
 * Drives the unread dot on the DMs button in the server rail.
 */
export function useHasUnreadDMs(): boolean {
  const { user } = useCurrentUser();
  const { conversations } = useDMConversations();
  const { getLastRead } = useReadState();

  return useMemo(() => {
    if (!user) return false;
    return conversations.some(
      (c) =>
        c.latest.pubkey !== user.pubkey &&
        c.latest.created_at > getLastRead(dmReadKey(c.peer)),
    );
  }, [user, conversations, getLastRead]);
}

/**
 * The decrypted message thread with a single peer, plus a `send` mutation.
 * Messages are kind-4 NIP-04 events on the DM relay, decrypted with the
 * signer's nip04 method.
 */
export function useDirectMessages(peer: string | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");

  const self = user?.pubkey;
  const queryKey = useMemo(
    () => ["dm", "thread", self, peer, relayKey] as const,
    [self, peer, relayKey],
  );

  const query = useQuery<DecryptedDM[]>({
    queryKey,
    enabled: !!self && !!peer && !!user?.signer.nip04,
    queryFn: async ({ signal }) => {
      const nip04 = user!.signer.nip04!;
      // Query ONLY self-scoped filters. Relays enforce that you may only read
      // your own DMs and reject (closing the whole REQ) any filter naming
      // another pubkey — so `authors:[peer]`/`#p:[peer]` would return nothing.
      // Our own kind-4 set covers both directions of every conversation:
      //   - sent to peer  → authored by self (`authors:[self]`)
      //   - received      → addressed to self (`#p:[self]`)
      // We then narrow to this peer client-side.
      const events = await nostr.group(relays).query(
        [
          { kinds: [KIND_DM], authors: [self!], limit: 1000 },
          { kinds: [KIND_DM], "#p": [self!], limit: 1000 },
        ],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      // Keep only events that belong to this 1:1 conversation.
      const inThread = events.filter((e) => dmCounterparty(e, self!) === peer);

      // De-duplicate (relays in the group may each return the same event).
      const byId = new Map<string, NostrEvent>();
      for (const event of inThread) byId.set(event.id, event);

      // Decrypt sequentially, not via Promise.all: NIP-07 extensions serialize
      // (and may reject) concurrent nip04.decrypt calls, which would otherwise
      // make every message fail and the thread look empty.
      const decrypted: DecryptedDM[] = [];
      for (const event of byId.values()) {
        const counterparty = event.pubkey === self ? peer! : event.pubkey;
        try {
          const content = await runExclusive(self!, () => nip04.decrypt(counterparty, event.content));
          decrypted.push({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, content });
        } catch (err) {
          // undecryptable (not actually for us, or signer refused) — skip
          console.warn("DM decrypt failed", { id: event.id, counterparty, err });
        }
      }

      return decrypted.sort((a, b) => a.created_at - b.created_at);
    },
    staleTime: 10_000,
  });

  // Cache-first seed: decrypt this thread from IndexedDB before the network
  // resolves, so a conversation we've opened renders instantly and survives a
  // page refresh. The store holds the raw kind-4 events (mirrored by
  // NostrBatcher); we read our own DM set by tag/author, narrow to this peer,
  // and decrypt locally.
  useEffect(() => {
    if (!self || !peer || !user?.signer.nip04) return;
    const nip04 = user.signer.nip04;
    let cancelled = false;
    void (async () => {
      if ((queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? []).length > 0) return;
      const store = await eventStore;
      const events = await store.query([
        { kinds: [KIND_DM], authors: [self], limit: 1000 },
        { kinds: [KIND_DM], "#p": [self], limit: 1000 },
      ]);
      if (cancelled || events.length === 0) return;

      const byId = new Map<string, NostrEvent>();
      for (const e of events) {
        if (dmCounterparty(e, self) === peer) byId.set(e.id, e);
      }
      if (byId.size === 0) return;

      const decrypted: DecryptedDM[] = [];
      for (const event of byId.values()) {
        const counterparty = event.pubkey === self ? peer : event.pubkey;
        try {
          const content = await runExclusive(self, () => nip04.decrypt(counterparty, event.content));
          decrypted.push({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, content });
        } catch {
          // undecryptable — skip
        }
      }
      if (cancelled || decrypted.length === 0) return;
      decrypted.sort((a, b) => a.created_at - b.created_at);
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old) =>
        old && old.length > 0 ? old : decrypted,
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self, peer, user?.signer.nip04, eventStore, queryClient]);

  // Live subscription for new messages in this thread.
  useEffect(() => {
    if (!self || !peer || !user?.signer.nip04) return;
    const nip04 = user.signer.nip04;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    (async () => {
      try {
        for await (const msg of nostr.group(relays).req(
          [
            { kinds: [KIND_DM], authors: [self], since },
            { kinds: [KIND_DM], "#p": [self], since },
          ],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrEvent;
          // Only messages in this 1:1 conversation.
          if (dmCounterparty(event, self) !== peer) continue;
          const counterparty = event.pubkey === self ? peer : event.pubkey;
          let content: string;
          try {
            content = await runExclusive(self, () => nip04.decrypt(counterparty, event.content));
          } catch (err) {
            console.warn("DM live decrypt failed", { id: event.id, counterparty, err });
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
  }, [nostr, self, peer, user?.signer.nip04, relayKey, queryClient]);

  // Backfill older history for this conversation. Because relays only serve
  // your own DMs (self-scoped filters), we page the global self-DM stream with
  // an `until` cursor and narrow to this peer client-side. `hasMore` flips off
  // once a page comes back short.
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const oldestRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);

  // Reset the cursor when the peer/relays change.
  useEffect(() => {
    oldestRef.current = undefined;
    setHasMore(true);
  }, [self, peer, relayKey]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!self || !peer || !user?.signer.nip04) return 0;
    if (loadingRef.current || !hasMore) return 0;

    const nip04 = user.signer.nip04;
    // First backfill starts from the oldest message currently rendered.
    const current = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
    const until =
      oldestRef.current ??
      (current.length > 0 ? current[0].created_at - 1 : Math.floor(Date.now() / 1000));

    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const events = await nostr.group(relays).query(
        [
          { kinds: [KIND_DM], authors: [self], until, limit: 500 },
          { kinds: [KIND_DM], "#p": [self], until, limit: 500 },
        ],
        { signal: AbortSignal.timeout(8000) },
      );

      if (events.length === 0) {
        setHasMore(false);
        return 0;
      }

      // Advance the cursor from the raw page (oldest event minus one second).
      const oldestEvent = Math.min(...events.map((e) => e.created_at));
      oldestRef.current = oldestEvent - 1;
      if (events.length < 500) setHasMore(false);

      const inThread = events.filter((e) => dmCounterparty(e, self) === peer);
      const existing = new Set(current.map((m) => m.id));

      const decrypted: DecryptedDM[] = [];
      for (const event of inThread) {
        if (existing.has(event.id)) continue;
        const counterparty = event.pubkey === self ? peer : event.pubkey;
        try {
          const content = await runExclusive(self, () => nip04.decrypt(counterparty, event.content));
          decrypted.push({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, content });
        } catch (err) {
          console.warn("DM backfill decrypt failed", { id: event.id, counterparty, err });
        }
      }

      if (decrypted.length === 0) return 0;

      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) => {
        const byId = new Map<string, DecryptedDM>();
        for (const m of [...decrypted, ...old]) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
      });
      return decrypted.length;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [self, peer, user?.signer.nip04, hasMore, queryClient, queryKey, nostr, relays]);

  /** Update a single optimistic message's delivery status in the cache. */
  const setMessageStatus = useCallback(
    (id: string, status: DecryptedDM["status"]) => {
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
        old.map((m) => (m.id === id ? { ...m, status } : m)),
      );
    },
    [queryClient, queryKey],
  );

  // Publish a signed DM in the background and reconcile its optimistic status.
  // The message is already rendered (status "sending") before this runs, so the
  // composer can clear immediately and the UI never blocks on the relay.
  const publish = useCallback(
    async (event: NostrEvent) => {
      try {
        await nostr.group(relays).event(event, { signal: AbortSignal.timeout(8000) });
        // Confirmed: drop the "sending" badge. The live subscription may also
        // echo this event back; dedup by id keeps it from duplicating.
        setMessageStatus(event.id, undefined);
        queryClient.invalidateQueries({ queryKey: ["dm", "conversations", user?.pubkey] });
      } catch (err) {
        setMessageStatus(event.id, "failed");
        throw err;
      }
    },
    [nostr, relays, setMessageStatus, queryClient, user?.pubkey],
  );

  const send = useMutation({
    // Encrypt + sign, render immediately, then publish in the background. The
    // mutation resolves as soon as the message is signed and shown (so the
    // composer clears instantly); delivery success/failure is reflected via the
    // message's `status` rather than by blocking the caller on the relay OK.
    //
    // Signing is serialized through `signChainRef`: NIP-07 extensions reject
    // concurrent encrypt/signEvent calls, so when the user fires several
    // messages in a row we must sign them one at a time. Each message is
    // rendered as a "sending" placeholder up front (keyed by a temporary local
    // id) so the queue is visible instantly, then reconciled to the real signed
    // event id once its turn in the sign queue comes up.
    mutationFn: async (text: string) => {
      if (!user?.signer.nip04) throw new Error("NIP-04 encryption not supported by signer");
      if (!peer) throw new Error("No recipient");
      const trimmed = text.trim();
      if (!trimmed) return;

      const signer = user.signer;
      const self = user.pubkey;
      // Temporary client-side id for the optimistic placeholder; swapped for the
      // real event id after signing.
      const tempId = `pending:${crypto.randomUUID()}`;
      const createdAt = Math.floor(Date.now() / 1000);

      // Render the queued message immediately, in order, before it even starts
      // signing — so rapid-fire sends all appear at once.
      queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
        [
          ...old,
          {
            id: tempId,
            pubkey: self,
            created_at: createdAt,
            content: trimmed,
            status: "sending" as const,
          },
        ].sort((a, b) => a.created_at - b.created_at),
      );
      // NOTE: deliberately do NOT invalidate the conversation-list query here.
      // Invalidating triggers a refetch + a re-decrypt of every conversation's
      // preview (each a NIP-07 round-trip) that contends with our in-flight
      // signing on the same extension — turning a burst of sends into a
      // thrash. The optimistic thread render already shows the message; the
      // conversation list re-orders on its next natural refetch / live event.

      // Encrypt + sign serialized against all other signer crypto for this
      // identity (extension-safe), then render the real id and publish in the
      // background.
      try {
        const event = await runExclusive(self, async () => {
          const content = await signer.nip04!.encrypt(peer, trimmed);
          return signer.signEvent({
            kind: KIND_DM,
            content,
            tags: [["p", peer]],
            created_at: createdAt,
          });
        });

        // Swap the placeholder for the real, signed event id (still "sending").
        queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
          old.map((m) =>
            m.id === tempId
              ? { ...m, id: event.id, created_at: event.created_at }
              : m,
          ),
        );

        // Publish in the background; don't make the caller await the relay.
        void publish(event).catch(() => {
          // Failure is surfaced via the message's "failed" status (and retry).
        });
      } catch {
        // Encryption/signing failed (e.g. extension rejected) — mark the
        // placeholder failed so it can be retried, and don't throw (the send is
        // fire-and-forget from the composer's perspective).
        setMessageStatus(tempId, "failed");
      }
    },
  });

  /** Re-publish a message that previously failed to send. */
  const retry = useCallback(
    (id: string) => {
      const messages = queryClient.getQueryData<DecryptedDM[]>(queryKey) ?? [];
      const failed = messages.find((m) => m.id === id && m.status === "failed");
      if (!failed || !user || !peer) return;
      const signer = user.signer;
      const self = user.pubkey;
      setMessageStatus(id, "sending");

      void (async () => {
        try {
          // Re-sign serialized against all other signer crypto, same as send.
          const event = await runExclusive(self, async () => {
            const content = await signer.nip04!.encrypt(peer, failed.content);
            return signer.signEvent({
              kind: KIND_DM,
              content,
              tags: [["p", peer]],
              created_at: failed.created_at,
            });
          });
          // The signed event id may differ from the placeholder id; reconcile.
          if (event.id !== id) {
            queryClient.setQueryData<DecryptedDM[]>(queryKey, (old = []) =>
              old.map((m) => (m.id === id ? { ...m, id: event.id } : m)),
            );
          }
          await publish(event);
        } catch {
          setMessageStatus(id, "failed");
        }
      })();
    },
    [queryClient, queryKey, user, peer, setMessageStatus, publish],
  );

  return {
    messages: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    send: send.mutateAsync,
    isSending: send.isPending,
    retry,
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

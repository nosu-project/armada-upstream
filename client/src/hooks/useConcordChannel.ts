import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useConcordBanlist } from "@/hooks/useConcordModeration";
import { useConcordChannelEpochs } from "@/hooks/useConcordRekey";
import { useConcordRoster } from "@/hooks/useConcordRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useRotatorSecretKey } from "@/hooks/useRotatorSecretKey";
import { forgetSkips, openMemoized, openMemoizedBatch } from "@/lib/concord/decodeCache";
import { channelPseudonym } from "@/lib/concord/derive";
import {
  buildInnerEvent,
  openedFromSealed,
  sealWithSignedInner,
  type OpenedMessage,
} from "@/lib/concord/envelope";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT, KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_REACTION } from "@/lib/concord/kinds";
import { canActOnMember, Permissions } from "@/lib/concord/roles";
import { runExclusive } from "@/lib/signerQueue";
import type { Channel, Community } from "@/lib/concord/types";

import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Optimistic delivery status for a Concord message we sent, keyed by message id. */
export type ConcordSendStatus = "pending" | "failed";
export type ConcordSendStatusMap = Record<string, ConcordSendStatus>;

/** Query key for a channel's decoded message list. */
function channelKey(channelIdHex: string | null) {
  return ["concord", "channel", channelIdHex] as const;
}

/** Query key for a channel's optimistic send-status map. */
function statusKey(channelIdHex: string | null) {
  return ["concord", "msg-status", channelIdHex] as const;
}

/**
 * Query key for a channel's optimistic-delete set: message ids the current user
 * has self-deleted locally, kept hidden until the relay echoes the delete back.
 */
function deletedKey(channelIdHex: string | null) {
  return ["concord", "msg-deleted", channelIdHex] as const;
}

/** The held epoch keys for a channel: every retained epoch, newest first. */
function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The set of `#z` pseudonyms to subscribe/query for a channel (one per held epoch). */
function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/** Moderation context the read path applies while folding. */
interface ModerationContext {
  /** Banned author pubkeys (hex): every event from them is dropped. */
  banned: Set<string>;
  /** Whether `deleter` is authorized to moderation-hide a message by `author`. */
  canHide: (deleter: string, author: string) => boolean;
}

/**
 * Fold a batch of ALREADY-OPENED Concord events into the channel timeline: drop
 * banned authors, apply edits (latest by ms, author-only) and deletes
 * (self-delete or authorized moderation-hide), and return the surviving
 * messages sorted by time plus the tombstone map (so a merge across fetches can
 * prune an already-known message whose author deleted it in THIS batch).
 *
 * Decoding (the expensive NIP-44 + verify) is done up front by the memoized
 * batch opener; this is the cheap, pure fold over the results.
 */
function foldOpened(
  opened: OpenedMessage[],
  moderation?: ModerationContext,
): { messages: OpenedMessage[]; deletes: Map<string, Set<string>> } {
  const byId = new Map<string, OpenedMessage>();
  // Tombstones: target message id → set of pubkeys that authored a delete for
  // it. A delete takes effect when authored by the message's OWN author
  // (cooperative self-delete) OR by an authorized moderator (moderation-hide).
  const deletes = new Map<string, Set<string>>();
  // Edits (3302): target id → newest {author, content, ms}. Applied only when
  // the edit's author IS the original message's author.
  const edits = new Map<string, { author: string; content: string; ms: number }>();
  for (const om of opened) {
    // Inbound ban enforcement: drop every event from a banned author.
    if (moderation?.banned.has(om.author)) continue;
    if (om.kind === KIND_COMMUNITY_DELETE) {
      const target = om.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      let authors = deletes.get(target);
      if (!authors) deletes.set(target, (authors = new Set()));
      authors.add(om.author);
      continue;
    }
    if (om.kind === KIND_COMMUNITY_EDIT) {
      const target = om.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      const prev = edits.get(target);
      if (!prev || om.ms > prev.ms) {
        edits.set(target, { author: om.author, content: om.content, ms: om.ms });
      }
      continue;
    }
    // Reactions are tallied elsewhere (useConcordReactions); keep them out of
    // the message timeline.
    if (om.kind === KIND_COMMUNITY_REACTION) continue;
    byId.set(om.messageId, om);
  }
  // Apply edits: only the original author may edit; latest edit (by ms) wins.
  for (const [id, edit] of edits) {
    const msg = byId.get(id);
    if (msg && edit.author === msg.author) {
      byId.set(id, { ...msg, content: edit.content });
    }
  }
  // Apply deletes: self-delete (author deleted their own) or an authorized
  // moderation-hide (a deleter who can act on the message's author).
  for (const [id, msg] of byId) {
    const deleters = deletes.get(id);
    if (!deleters) continue;
    const hidden =
      deleters.has(msg.author) ||
      (moderation && [...deleters].some((d) => moderation.canHide(d, msg.author)));
    if (hidden) byId.delete(id);
  }
  // Return the tombstone map too, so a merge across fetches can prune an
  // already-known message whose author published a delete in THIS batch.
  return { messages: [...byId.values()].sort((a, b) => a.ms - b.ms), deletes };
}

/**
 * Open + fold a batch of sealed outer events into the channel timeline. Decode
 * is memoized per wrapper id and chunked off the main thread (so re-reading the
 * append-only local store costs near-nothing after the first pass, and a large
 * first decode never freezes the UI); the surviving messages are then folded
 * (edits/deletes/bans applied) and returned sorted by time. Shared by the live
 * subscription, the network backfill, and the IndexedDB cache-first seed.
 */
async function openMessages(
  events: NostrEvent[],
  channelId: Uint8Array,
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>,
  moderation?: ModerationContext,
  signal?: AbortSignal,
): Promise<{ messages: OpenedMessage[]; deletes: Map<string, Set<string>> }> {
  const opened = await openMemoizedBatch(events, channelId, epochKeys, { signal });
  return foldOpened(opened, moderation);
}

/**
 * Read a channel's sealed blobs back from the append-only local event store and
 * fold them into the timeline. The store (NIndexedDB, `armada-events`) mirrors
 * every sealed outer the relays ever returned, so it is the complete local
 * source of truth — like Vector's SQLite. Reading + decoding from it (rather
 * than re-querying relays) is what makes a visited channel paint instantly and
 * survive offline; decode-once memoization makes repeat reads cheap.
 */
async function readAndFold(
  store: { query: (filters: NostrFilter[]) => Promise<NostrEvent[]> },
  channel: Channel,
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>,
  zs: string[],
  moderation?: ModerationContext,
  signal?: AbortSignal,
): Promise<{ messages: OpenedMessage[]; deletes: Map<string, Set<string>> }> {
  // No limit: the local store is the source of truth and is append-only, so we
  // want every sealed blob it holds, not a truncated window. Decode-once keeps
  // this cheap on repeat reads.
  const sealed = await store.query([
    { kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT], "#z": zs },
  ]);
  return openMessages(sealed, channel.id, epochKeys, moderation, signal);
}

/** A page size for relay backfill; the local store is unbounded, this just bounds each REQ. */
const BACKFILL_PAGE = 500;
/** How many `until`-pages to walk per backfill pass, so one tick can't loop forever. */
const BACKFILL_MAX_PAGES = 6;

/**
 * Backfill the local store from the relays, walking older history with `until`
 * pagination so a channel with more than {@link BACKFILL_PAGE} events isn't
 * permanently truncated to its newest page (the old single `limit: 500` query
 * silently lost everything older). Each relay query is mirrored into the local
 * store by NostrBatcher's `relay()` wrapper, so this just populates the
 * append-only store; the caller re-reads from the store afterward.
 *
 * Returns the OLDEST `created_at` seen across the pass, so a caller tracking a
 * per-channel backfill cursor can resume from there next time instead of
 * re-walking the same window. Stops early when a page comes back short (the
 * relays have no older events) or the page budget is exhausted.
 */
async function backfillStore(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  zs: string[],
  signal: AbortSignal,
  until?: number,
): Promise<number | undefined> {
  let cursor = until;
  let oldest: number | undefined;
  for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
    if (signal.aborted) break;
    const filter: NostrFilter = {
      kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT],
      "#z": zs,
      limit: BACKFILL_PAGE,
    };
    if (cursor !== undefined) filter.until = cursor;
    const results = await Promise.all(
      relays.map((url) =>
        nostr
          .relay(url)
          .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
          .catch(() => [] as NostrEvent[]),
      ),
    );
    const flat = results.flat();
    if (flat.length === 0) break;
    let pageOldest = Infinity;
    for (const ev of flat) if (ev.created_at < pageOldest) pageOldest = ev.created_at;
    if (Number.isFinite(pageOldest)) oldest = pageOldest;
    // A page shorter than a full window means the relays have no older events
    // past this point — stop walking.
    if (flat.length < BACKFILL_PAGE) break;
    // Step the cursor strictly older than the oldest event we just saw.
    if (!Number.isFinite(pageOldest) || pageOldest <= 0) break;
    const next = pageOldest - 1;
    if (cursor !== undefined && next >= cursor) break; // no forward progress
    cursor = next;
  }
  return oldest;
}

/**
 * Fetch + decrypt the messages of one Concord channel from the community's
 * relays. Queries every retained-epoch pseudonym (`#z`), opens each sealed outer
 * event under the matching epoch key (binding triad enforced), and returns the
 * verified messages sorted by time. Foreign/old-epoch blobs are silently
 * skipped (NoHeldEpoch), exactly as Vector's read path does.
 *
 * Cache-first: while the network query is in flight, the channel's sealed
 * events are read back from IndexedDB by their `#z` pseudonyms and decrypted
 * locally, so a channel we've visited renders instantly and survives a page
 * refresh (the relays only ever stored opaque blobs; decryption is local).
 */
export function useConcordChannelMessages(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const roster = useConcordRoster(community);
  const banlist = useConcordBanlist(community);
  const mySkHex = useRotatorSecretKey();
  // Catch up post-rekey epoch keys from the relays (the bundle only conveys the
  // current key at join). The read path opens messages under ALL retained
  // epochs, so a member who was present through a ban-rekey keeps reading.
  const caughtUp = useConcordChannelEpochs(community, channel, mySkHex);

  // Moderation context for the read path: drop banned authors' events, and let
  // an authorized moderator's 3305 hide another member's message. Verified
  // against the folded roster so a forged hide/ban has no effect.
  const moderation = useMemo(() => {
    const banned = banlist.data?.banned ?? new Set<string>();
    const r = roster.data;
    return {
      banned,
      canHide: (deleter: string, author: string) =>
        Boolean(r && canActOnMember(r.roster, deleter, r.ownerHex, author, Permissions.MANAGE_MESSAGES)),
    };
  }, [banlist.data, roster.data]);

  /** The full set of epoch keys to decode under: bundle seed ∪ caught-up. */
  const allEpochKeys = useMemo(() => {
    if (!channel) return [];
    const byEpoch = new Map<string, { epoch: bigint; key: Uint8Array }>();
    for (const ek of readEpochKeys(channel)) byEpoch.set(ek.epoch.toString(), ek);
    for (const ek of caughtUp.data ?? []) byEpoch.set(ek.epoch.toString(), ek);
    return [...byEpoch.values()].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
  }, [channel, caughtUp.data]);

  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  // Epoch signature: changes when a rekey is caught up, so we can re-read.
  const epochSig = allEpochKeys.map((e) => e.epoch.toString()).join(",");
  const queryKey = ["concord", "channel", channelIdHex];

  // Per-channel backfill cursor (oldest created_at walked so far). Lets each
  // poll resume paging OLDER history into the local store instead of re-walking
  // the newest window every time, so a channel with >500 events fills in fully.
  const backfillCursor = useRef<Map<string, number | undefined>>(new Map());

  // Re-read immediately when the held epoch set changes (a rekey was caught up),
  // rather than waiting for the next poll. Forget remembered decode FAILURES so
  // blobs previously skipped as `no-held-epoch` retry under the new keys.
  useEffect(() => {
    if (!channelIdHex) return;
    forgetSkips();
    queryClient.invalidateQueries({ queryKey: ["concord", "channel", channelIdHex] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochSig]);

  // Live subscription for new messages — the same streaming `req()` NIP-29 chat
  // uses (useGroupMessages), so a member's message lands in the UI the instant
  // the relay forwards it instead of waiting for the 15s poll. Each arriving
  // sealed outer is opened incrementally (binding triad + moderation enforced)
  // and upserted into the existing query cache by message id; the periodic poll
  // remains a backstop for missed events / reconnection.
  useEffect(() => {
    if (!community || !channel || !channelIdHex || allEpochKeys.length === 0) return;
    const zs = allEpochKeys.map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
    const relays = community.relays;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000) - 5;

    /** Open one batch of sealed outers and fold them into the cached timeline. */
    const apply = async (events: NostrEvent[]) => {
      if (events.length === 0) return;
      const { messages: opened, deletes } = await openMessages(events, channel.id, allEpochKeys, moderation);
      if (opened.length === 0 && deletes.size === 0) return;
      queryClient.setQueryData<OpenedMessage[]>(queryKey, (old = []) => {
        const byId = new Map<string, OpenedMessage>();
        for (const m of old) byId.set(m.messageId, m);
        let changed = false;
        for (const m of opened) {
          if (moderation.banned.has(m.author)) continue;
          const existing = byId.get(m.messageId);
          // Skip if we already have an identical copy (the relay echoes our own
          // optimistic send and re-forwards on reconnect); upsert otherwise.
          if (existing && existing.content === m.content && existing.ms === m.ms) continue;
          byId.set(m.messageId, m);
          changed = true;
        }
        // Honor self-delete / authorized moderation-hide arriving live.
        for (const [id, deleters] of deletes) {
          const msg = byId.get(id);
          if (!msg) continue;
          if (deleters.has(msg.author) || [...deleters].some((d) => moderation.canHide(d, msg.author))) {
            byId.delete(id);
            changed = true;
          }
        }
        if (!changed) return old;
        // Clear optimistic "pending"/"failed" for anything the relay echoed back.
        const confirmed = opened.map((m) => m.messageId);
        if (confirmed.length > 0) {
          queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (s = {}) => {
            let touched = false;
            const next = { ...s };
            for (const id of confirmed) if (id in next) { delete next[id]; touched = true; }
            return touched ? next : s;
          });
        }
        return [...byId.values()].sort((a, b) => a.ms - b.ms);
      });
    };

    for (const url of relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [{ kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE, KIND_COMMUNITY_EDIT], "#z": zs, since }],
            { signal: controller.signal },
          )) {
            if (msg[0] === "EVENT") await apply([msg[2] as NostrEvent]);
          }
        } catch {
          // Subscription ended (abort or relay closed) — the poll covers gaps.
        }
      })();
    }

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community, channelIdHex, epochSig, moderation, queryClient]);

  return useQuery({
    queryKey,
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // Backstop + backfill. The live subscription delivers NEW messages
    // instantly; this poll heals gaps (dropped subscription / missed event) and
    // walks OLDER history into the append-only local store via `until`
    // pagination, then renders from the store. Decode-once memoization keeps the
    // re-read cheap, so re-reading the whole local window each tick is fine.
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const epochKeys = allEpochKeys;
      const zs = epochKeys.map((ek) => bytesToHex(channelPseudonym(ek.key, channel!.id, ek.epoch)));
      const relays = community!.relays;
      const store = await eventStore;

      /**
       * Re-read the append-only local store, fold it together with whatever is
       * already shown (live/optimistic messages not yet in the store), apply
       * moderation + optimistic-delete + send-status reconciliation, and return
       * the timeline. Used for BOTH the immediate local-first result and the
       * post-backfill refresh.
       */
      const composeFromStore = async (): Promise<OpenedMessage[]> => {
        const { messages: opened, deletes } = await readAndFold(
          store,
          channel!,
          epochKeys,
          zs,
          moderation,
          signal,
        );

        // Union by message id with what's already shown; the store read wins on
        // conflict (it's verified), but a just-arrived live message / optimistic
        // send not yet in the store survives.
        const prev = queryClient.getQueryData<OpenedMessage[]>(queryKey) ?? [];
        const byId = new Map<string, OpenedMessage>();
        for (const m of prev) byId.set(m.messageId, m);
        for (const m of opened) byId.set(m.messageId, m);
        for (const [id, msg] of byId) {
          // Drop banned authors and honor self-delete / authorized moderation-hide.
          if (moderation.banned.has(msg.author)) {
            byId.delete(id);
            continue;
          }
          const deleters = deletes.get(id);
          if (deleters && (deleters.has(msg.author) || [...deleters].some((d) => moderation.canHide(d, msg.author)))) {
            byId.delete(id);
          }
        }

        // Honor optimistic self-deletes: hide ids the user just deleted locally
        // until the relay's own delete event lands (at which point `readAndFold`
        // already drops the message and we can forget the optimistic hint).
        const optimisticDeleted =
          queryClient.getQueryData<string[]>(deletedKey(channelIdHex)) ?? [];
        if (optimisticDeleted.length > 0) {
          const stillHidden: string[] = [];
          for (const id of optimisticDeleted) {
            if (byId.has(id)) {
              byId.delete(id);
              stillHidden.push(id);
            }
            // else: the relay already dropped it; clear the optimistic hint.
          }
          if (stillHidden.length !== optimisticDeleted.length) {
            queryClient.setQueryData<string[]>(deletedKey(channelIdHex), stillHidden);
          }
        }

        // Reconcile optimistic send-status: clear "pending"/"failed" for any
        // message the relays have now echoed back into the local store.
        const status = queryClient.getQueryData<ConcordSendStatusMap>(statusKey(channelIdHex)) ?? {};
        const confirmed = opened.filter((m) => status[m.messageId]).map((m) => m.messageId);
        if (confirmed.length > 0) {
          queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (old = {}) => {
            const next = { ...old };
            for (const id of confirmed) delete next[id];
            return next;
          });
        }

        return [...byId.values()].sort((a, b) => a.ms - b.ms);
      };

      // 1. LOCAL-FIRST: resolve the query from the local store immediately, so
      //    `isLoading` reflects only the (fast) IndexedDB read + decode — never
      //    the multi-relay network walk. A refresh / offline launch paints the
      //    full local history at once instead of behind the skeleton.
      const local = await composeFromStore();

      // 2. BACKGROUND BACKFILL: walk the relays (newest window + older-history
      //    continuation) into the append-only store, then re-read and update the
      //    cache. NOT awaited — the network never gates the visible timeline.
      void (async () => {
        if (signal.aborted) return;
        const cursorKey = channelIdHex ?? "";
        await backfillStore(nostr, relays, zs, signal); // newest window
        const resumeFrom = backfillCursor.current.get(cursorKey);
        const oldest = await backfillStore(nostr, relays, zs, signal, resumeFrom);
        if (oldest !== undefined && (resumeFrom === undefined || oldest < resumeFrom)) {
          backfillCursor.current.set(cursorKey, oldest);
        }
        if (signal.aborted) return;
        const refreshed = await composeFromStore();
        queryClient.setQueryData<OpenedMessage[]>(queryKey, refreshed);
      })().catch(() => {
        // Best-effort background heal; the local-first result already rendered.
      });

      return local;
    },
  });
}

/**
 * Send a sealed message into a Concord channel, optimistically and queueably.
 *
 * Mirrors the DM/NIP-29 behavior: a real message (kind 3300/3302) is rendered
 * immediately with `pending` status the moment its inner authorship event is
 * signed, the relay broadcast happens in the background, and the message is
 * reconciled (status cleared) when the relays echo it back on the next refetch.
 * A failed broadcast marks the message `failed` (retryable). Signing is
 * serialized through the per-identity signer queue so a burst of sends never
 * races on a NIP-07 extension.
 *
 * Non-message sends (reactions 3301, deletes 3305) don't render as chat rows,
 * so they skip the optimistic insert but still serialize their signing.
 */
export function useSendConcordMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const channelIdHex = channel ? bytesToHex(channel.id) : null;

  const setStatus = useCallback(
    (id: string, status: ConcordSendStatus | undefined) => {
      queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (old = {}) => {
        if (status === undefined) {
          if (!(id in old)) return old;
          const next = { ...old };
          delete next[id];
          return next;
        }
        return { ...old, [id]: status };
      });
    },
    [queryClient, channelIdHex],
  );

  /** Broadcast a sealed outer to the community's relays. Throws if none accept. */
  const broadcast = useCallback(
    async (outer: NostrEvent) => {
      const results = await Promise.allSettled(
        community!.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
        ),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the message.");
      }
    },
    [nostr, community],
  );

  return useMutation({
    mutationFn: async ({
      content,
      kind = KIND_COMMUNITY_MESSAGE,
      reference,
      extraTags,
    }: {
      content: string;
      /** 3300 message (default), 3301 reaction, 3302 edit. */
      kind?: number;
      /** Target inner id for a reply/reaction/edit. */
      reference?: string;
      /** Extra inner tags appended verbatim (e.g. NIP-30 `emoji`, NIP-92 imeta). */
      extraTags?: string[][];
    }) => {
      if (!user) throw new Error("Sign in to send a message.");
      if (!community || !channel) throw new Error("No channel selected.");

      const self = user.pubkey;
      const signer = user.signer;
      const isChatMessage = kind === KIND_COMMUNITY_MESSAGE || kind === 3302;

      // Inner authorship event signed by the user's real identity (the proof of
      // who wrote it), then sealed under the channel key with a throwaway outer
      // key. Signing is serialized per-identity (extension-safe).
      const ms = Date.now();
      const innerTemplate = buildInnerEvent({
        channelId: channel.id,
        epoch: channel.epoch,
        content,
        ms,
        kind,
        reference,
        extraTags,
      });

      // Sign + seal serialized per-identity (extension-safe). If this throws
      // (signer rejected / sealing failed) it propagates to the caller before
      // anything is rendered; the composer shows a toast and keeps the draft.
      const signed = await runExclusive(self, async () => {
        const signedInner = await signer.signEvent(innerTemplate);
        const sealed = sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
        return { signedInner, sealed };
      });
      const outer = signed.sealed;
      const innerId = signed.signedInner.id;

      // Optimistically render real messages immediately as "pending".
      if (isChatMessage) {
        const optimistic = openedFromSealed(signed.signedInner, signed.sealed, channel.id, channel.epoch);
        queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
          old.some((m) => m.messageId === optimistic.messageId)
            ? old
            : [...old, optimistic].sort((a, b) => a.ms - b.ms),
        );
        setStatus(innerId, "pending");
      }

      // Broadcast in the background so the composer never blocks on the relay.
      // Real messages reconcile their status via the message-list refetch (the
      // relay echo clears "pending"); mark "failed" if no relay accepts.
      void broadcast(outer)
        .then(() => {
          if (channel) {
            queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
          }
        })
        .catch(() => {
          if (isChatMessage) setStatus(innerId, "failed");
        });

      return { outer, messageId: innerId, isChatMessage };
    },
  });
}

/**
 * Re-broadcast a Concord message that previously failed to send. The sealed
 * outer is reconstructed from the still-rendered optimistic message (we hold
 * the verified inner content + tags), re-signed through the signer queue, and
 * re-broadcast. The message id is preserved so it reconciles on refetch.
 */
export function useRetryConcordMessage(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const channelIdHex = channel ? bytesToHex(channel.id) : null;

  const setStatus = useCallback(
    (id: string, status: ConcordSendStatus | undefined) => {
      queryClient.setQueryData<ConcordSendStatusMap>(statusKey(channelIdHex), (old = {}) => {
        if (status === undefined) {
          const next = { ...old };
          delete next[id];
          return next;
        }
        return { ...old, [id]: status };
      });
    },
    [queryClient, channelIdHex],
  );

  const retry = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const messages = queryClient.getQueryData<OpenedMessage[]>(channelKey(channelIdHex)) ?? [];
      const msg = messages.find((m) => m.messageId === id);
      if (!msg) return;
      const self = user.pubkey;
      const signer = user.signer;
      setStatus(id, "pending");

      void (async () => {
        try {
          const outer = await runExclusive(self, async () => {
            // Rebuild the inner from the original content/tags. `buildInnerEvent`
            // re-derives the binding tags; the reply reference (if any) is in the
            // original inner's `e` tag.
            const reference = msg.tags.find((t) => t[0] === "e")?.[1];
            const innerTemplate = buildInnerEvent({
              channelId: channel.id,
              epoch: channel.epoch,
              content: msg.content,
              ms: msg.ms,
              kind: msg.kind,
              reference,
            });
            const signedInner = await signer.signEvent(innerTemplate);
            return sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
          });
          const results = await Promise.allSettled(
            community.relays.map((url) =>
              nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
            ),
          );
          if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("No relay accepted the message.");
          }
          queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
        } catch {
          setStatus(id, "failed");
        }
      })();
    },
    [user, community, channel, channelIdHex, queryClient, nostr, setStatus],
  );

  /** Drop a failed optimistic message from the channel view. */
  const discard = useCallback(
    (id: string) => {
      queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.messageId !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, channelIdHex, setStatus],
  );

  /**
   * Optimistically self-delete a message: hide it immediately, then publish the
   * sealed 3305 in the background. On failure, restore the message (and clear
   * the optimistic-delete hint) so it doesn't silently vanish. The hide is
   * recorded in the optimistic-delete set so a background refetch (which may
   * still see the message before the relay echoes the delete) keeps it hidden.
   */
  const deleteMessage = useCallback(
    (id: string) => {
      if (!user || !community || !channel) return;
      const self = user.pubkey;
      const signer = user.signer;

      const messages = queryClient.getQueryData<OpenedMessage[]>(channelKey(channelIdHex)) ?? [];
      const target = messages.find((m) => m.messageId === id);

      // Hide immediately: remove from the rendered list and remember the id so
      // a refetch before the relay confirms doesn't un-hide it.
      queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
        old.filter((m) => m.messageId !== id),
      );
      queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
        old.includes(id) ? old : [...old, id],
      );

      const restore = () => {
        if (target) {
          queryClient.setQueryData<OpenedMessage[]>(channelKey(channelIdHex), (old = []) =>
            old.some((m) => m.messageId === id)
              ? old
              : [...old, target].sort((a, b) => a.ms - b.ms),
          );
        }
        queryClient.setQueryData<string[]>(deletedKey(channelIdHex), (old = []) =>
          old.filter((d) => d !== id),
        );
      };

      void (async () => {
        try {
          const outer = await runExclusive(self, async () => {
            const innerTemplate = buildInnerEvent({
              channelId: channel.id,
              epoch: channel.epoch,
              content: "",
              ms: Date.now(),
              kind: KIND_COMMUNITY_DELETE,
              reference: id,
            });
            const signedInner = await signer.signEvent(innerTemplate);
            return sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
          });
          const results = await Promise.allSettled(
            community.relays.map((url) =>
              nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }),
            ),
          );
          if (!results.some((r) => r.status === "fulfilled")) {
            throw new Error("No relay accepted the delete.");
          }
          queryClient.invalidateQueries({ queryKey: channelKey(channelIdHex) });
        } catch {
          // Couldn't publish the delete — bring the message back so the user
          // knows it wasn't removed.
          restore();
        }
      })();
    },
    [user, community, channel, channelIdHex, queryClient, nostr],
  );

  return { retry, discard, deleteMessage };
}

/** Read a channel's optimistic send-status map (pending/failed by message id). */
export function useConcordSendStatus(channel: Channel | undefined): ConcordSendStatusMap {
  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  const { data } = useQuery<ConcordSendStatusMap>({
    queryKey: statusKey(channelIdHex),
    queryFn: () => ({}),
    enabled: Boolean(channelIdHex),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? {};
}

/** A tallied reaction key: reactors plus the NIP-30 custom-emoji image URL (if any). */
export interface ConcordReactionTally {
  reactors: Set<string>;
  /** Custom-emoji image URL when the key is a `:shortcode:` (from the reaction's `emoji` tag). */
  url?: string;
}

/**
 * Fetch + decrypt reactions (kind 3301) for a channel and tally them per target
 * message. Each reaction's `content` is the emoji; its reply `e` tag names the
 * reacted-to message. A NIP-30 custom-emoji reaction additionally carries an
 * `emoji` tag (`["emoji", shortcode, url]`) so the pill renders the image rather
 * than the literal `:shortcode:`. Reuses the same per-epoch envelope read path.
 */
export function useConcordReactions(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ["concord", "reactions", channel ? bytesToHex(channel.id) : null],
    enabled: Boolean(community && channel),
    staleTime: 10_000,
    // Reactions are less latency-critical than messages and re-tally the whole
    // window per poll; keep the cadence modest to limit repeated decryption.
    refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const epochKeys = readEpochKeys(channel!);
      const zs = channelPseudonyms(channel!);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [3301], "#z": zs, limit: 500 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      // target id → emoji → { reactors, url }
      const tally = new Map<string, Map<string, ConcordReactionTally>>();
      for (const ev of results.flat()) {
        // Memoized open: a re-tally each poll re-reads the same blobs, so
        // decode-once keeps the repeated verify cost off the main thread.
        const opened = openMemoized(ev, channel!.id, epochKeys);
        if (!opened) continue; // not ours / invalid
        const target = opened.tags.find((t) => t[0] === "e")?.[1];
        if (!target || !opened.content) continue;
        // NIP-30 custom emoji: content is `:shortcode:`, the `emoji` tag holds
        // its image URL (`["emoji", shortcode, url]`). Keep it so the pill can
        // render the image instead of the literal shortcode text.
        const url = opened.tags.find((t) => t[0] === "emoji")?.[2];
        let byEmoji = tally.get(target);
        if (!byEmoji) tally.set(target, (byEmoji = new Map()));
        let entry = byEmoji.get(opened.content);
        if (!entry) byEmoji.set(opened.content, (entry = { reactors: new Set() }));
        entry.reactors.add(opened.author);
        if (url && !entry.url) entry.url = url;
      }
      return tally;
    },
  });
}

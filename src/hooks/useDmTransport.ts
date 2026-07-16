import { useCallback, useMemo, useRef } from "react";

import { toChatMsg } from "@/components/chat/transport";
import { KIND_DM, useDirectMessages } from "@/hooks/useDirectMessages";
import { useDm17Thread } from "@/hooks/useDm17";
import { useDmProtocolPref } from "@/hooks/useDmProtocolPref";
import { reactionContentKey } from "@/hooks/useReactions";
import { KIND_DM_CHAT } from "@/lib/nip17/protocol";
import { useCurrentUser } from "@/hooks/useCurrentUser";

import type { ChatMsg, ChatTransport, MessageReactions, ReactInput, ReactionTally, SendStatus } from "@/components/chat/transport";
import type { DecryptedDM } from "@/hooks/useDirectMessages";
import type { OpenedDm } from "@/lib/nip17/protocol";

/** Shared empty tally array, so messages with no reactions keep a stable prop. */
const EMPTY_TALLIES: ReactionTally[] = [];

/**
 * Thrown by {@link useDmTransport}'s `send` when the peer isn't reachable over
 * NIP-17 and the caller hasn't opted into the legacy kind-4 downgrade. The DM
 * page catches this to surface an explicit "send with legacy encryption"
 * affordance instead of silently downgrading.
 */
export class LegacyFallbackRequired extends Error {
  constructor() {
    super("This person can't receive private (NIP-17) messages yet.");
    this.name = "LegacyFallbackRequired";
  }
}

/**
 * Build a {@link ChatTransport} for a 1:1 DM thread, so DMs render through the
 * same `MessageTimeline` / `ChatMessage` path as NIP-29 groups and Concord
 * communities instead of a bespoke timeline.
 *
 * The thread is the MERGE of two planes:
 *
 *   - Legacy kind-4 (NIP-04) events — Armada's historical DM plane, still
 *     read/written for peers that haven't published a NIP-17 inbox.
 *   - NIP-17 gift-wrapped rumors (kind 14/15) — the modern plane, with
 *     reactions (kind-7 rumors) and deletes (kind-5 rumors) in-band.
 *
 * Sends prefer NIP-17 whenever the peer has published a kind-10050 DM-relay
 * list (the spec's "ready to receive" signal) and the signer does NIP-44.
 * When the peer is NOT NIP-17-reachable, the legacy kind-4 plane is the only
 * option — but it's a privacy downgrade (kind-4 leaks who's talking and when),
 * so it is NEVER used silently: `send` refuses with `LegacyFallbackRequired`
 * and the caller must opt in explicitly (`send(text, tags, { allowLegacy })`)
 * after telling the user. Reactions/deletes exist only on the NIP-17 plane.
 *
 * Two kind-4-specific concerns the shared timeline can't model are surfaced
 * alongside the transport for the page's `renderMessage` to handle:
 *   - `encryptedIds`: kind-4 ids whose plaintext hasn't been decrypted yet
 *     (NIP-17 rumors are stored decrypted — never placeholders).
 *   - `decryptVisible`: decrypt a placeholder by id (IntersectionObserver).
 */
export function useDmTransport(peer: string): {
  transport: ChatTransport;
  /** Ids of kind-4 messages still awaiting lazy decryption (placeholder rows). */
  encryptedIds: Set<string>;
  /** Ids of NIP-17 rumors (unsigned; the page passes the `rumor` menu prop). */
  dm17Ids: Set<string>;
  /**
   * Whether sends go over NIP-17. True when the private plane is usable and
   * the per-conversation preference isn't pinned to legacy NIP-04.
   */
  dm17Enabled: boolean;
  /**
   * Whether private (NIP-17) delivery is GUARANTEED-reachable: the peer
   * published a kind-10050 inbox. When false but `dm17Enabled` is true, the
   * private DM is delivered best-effort to shared app/DM relays.
   */
  dm17DeliveryGuaranteed: boolean;
  /** Decrypt a placeholder message by id (on scroll into view). */
  decryptVisible: (id: string) => void;
  /** Explicitly decrypt one message (per-message "Decrypt" button). */
  decryptOne: (id: string) => void;
  /** Explicitly decrypt every encrypted row + grant consent ("Decrypt all"). */
  decryptAll: () => void;
  /** Whether the user declined bulk decryption (drives the manual controls). */
  decryptDeclined: boolean;
  /** Whether any row is still an encrypted placeholder. */
  hasEncrypted: boolean;
  /** Whether the peer can receive private NIP-17 DMs (published a kind-10050 inbox). */
  canDm17: boolean;
  /**
   * Whether this conversation is deliberately pinned to legacy NIP-04 (the
   * per-conversation preference). Sends go over kind-4 without the
   * LegacyFallbackRequired opt-in, and the page skips the downgrade notice.
   */
  legacyPinned: boolean;
  /**
   * Sign + optimistically send a DM; resolves once rendered (relay in bg).
   * Routes NIP-17 when the peer is reachable; otherwise throws
   * {@link LegacyFallbackRequired} unless `opts.allowLegacy` opts into kind-4.
   */
  send: (text: string, tags?: string[][], opts?: { allowLegacy?: boolean }) => Promise<void>;
} {
  const { user } = useCurrentUser();
  const {
    messages,
    isLoading,
    send: sendKind4,
    retry: retryKind4,
    loadOlder: loadOlderKind4,
    hasMore: hasMoreKind4,
    isLoadingOlder: isLoadingOlderKind4,
    decryptVisible,
    decryptOne,
    decryptAll,
    decryptDeclined,
    hasEncrypted,
  } = useDirectMessages(peer);

  const dm17 = useDm17Thread(peer);
  const self = user?.pubkey;
  const { pref } = useDmProtocolPref(peer);

  // Adapt DecryptedDM → ChatMsg, preserving object identity for unchanged
  // messages so React.memo on the rows holds (a fresh array lands on every
  // poll/decrypt). Key the cache on content + status, the only fields that
  // affect the rendered row.
  const adaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const kind4Messages = useMemo<ChatMsg[]>(() => {
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

  // Adapt NIP-17 rumors → ChatMsg with the same identity-caching discipline.
  const dm17AdaptCache = useRef(new Map<string, { sig: string; msg: ChatMsg }>());
  const dm17Messages = useMemo<ChatMsg[]>(() => {
    const cache = dm17AdaptCache.current;
    const next = new Map<string, { sig: string; msg: ChatMsg }>();
    const out = dm17.messages.map((m: OpenedDm) => {
      const sig = `${m.createdAt}\u0000${m.content}`;
      const hit = cache.get(m.rumorId);
      const entry =
        hit && hit.sig === sig
          ? hit
          : {
              sig,
              msg: toChatMsg({
                id: m.rumorId,
                pubkey: m.author,
                created_at: m.createdAt,
                kind: m.kind,
                content: m.content,
                tags: m.tags,
              }),
            };
      next.set(m.rumorId, entry);
      return entry.msg;
    });
    dm17AdaptCache.current = next;
    return out;
  }, [dm17.messages]);

  const dm17Ids = useMemo(() => new Set(dm17Messages.map((m) => m.id)), [dm17Messages]);
  /** Rumor kind by id, for reaction/delete targets (`k` tags). */
  const dm17KindById = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of dm17.messages) out.set(m.rumorId, m.kind);
    return out;
  }, [dm17.messages]);

  // The merged, ascending timeline. Ids never collide across planes (event
  // ids vs rumor hashes), so this is a pure sort-merge.
  const chatMessages = useMemo<ChatMsg[]>(() => {
    if (dm17Messages.length === 0) return kind4Messages;
    if (kind4Messages.length === 0) return dm17Messages;
    return [...kind4Messages, ...dm17Messages].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
    );
  }, [kind4Messages, dm17Messages]);

  const encryptedIds = useMemo(
    () => new Set(messages.filter((m) => m.encrypted).map((m) => m.id)),
    [messages],
  );

  // Optimistic send status: kind-4 rows embed theirs; NIP-17 tracks pending
  // rumors in the thread hook.
  const kind4StatusById = useMemo(() => {
    const out = new Map<string, SendStatus>();
    for (const m of messages) {
      if (m.status === "sending") out.set(m.id, "pending");
      else if (m.status === "failed") out.set(m.id, "failed");
    }
    return out;
  }, [messages]);

  const dm17SendStatusFor = dm17.sendStatusFor;
  const sendStatusFor = useCallback(
    (id: string) => kind4StatusById.get(id) ?? dm17SendStatusFor(id),
    [kind4StatusById, dm17SendStatusFor],
  );

  const retryById = useCallback(
    (event: ChatMsg) => {
      if (dm17Ids.has(event.id)) dm17.retry(event.id);
      else retryKind4(event.id);
    },
    [dm17Ids, dm17.retry, retryKind4], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const discard = useCallback(
    (id: string) => {
      if (dm17Ids.has(id)) dm17.discard(id);
    },
    [dm17Ids, dm17.discard], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── Reactions (NIP-17 plane only) ─────────────────────────────────────────
  // Tally kind-7 rumors per target: one reaction per (pubkey, key), latest
  // wins; retracting publishes a kind-5 delete of the own reaction rumor.
  const talliesById = useMemo(() => {
    const out = new Map<string, ReactionTally[]>();
    for (const [targetId, reactions] of dm17.reactionsByTarget) {
      const latest = new Map<string, OpenedDm>();
      for (const r of reactions) {
        const key = `${r.author}:${reactionContentKey(r.content)}`;
        const existing = latest.get(key);
        if (!existing || r.createdAt > existing.createdAt) latest.set(key, r);
      }
      const byKey = new Map<string, { url?: string; pubkeys: string[]; mineEventId?: string }>();
      for (const r of latest.values()) {
        const key = reactionContentKey(r.content);
        let entry = byKey.get(key);
        if (!entry) {
          byKey.set(key, (entry = { url: r.tags.find(([n]) => n === "emoji")?.[2], pubkeys: [] }));
        }
        entry.pubkeys.push(r.author);
        if (self && r.author === self) entry.mineEventId = r.rumorId;
      }
      const tallies: ReactionTally[] = [...byKey.entries()].map(([key, e]) => ({
        key,
        url: e.url,
        count: e.pubkeys.length,
        pubkeys: e.pubkeys,
        mine: e.mineEventId !== undefined,
        mineEventId: e.mineEventId,
      }));
      tallies.sort((a, b) => b.count - a.count);
      out.set(targetId, tallies);
    }
    return out;
  }, [dm17.reactionsByTarget, self]);

  const dm17React = dm17.react;
  const dm17RemoveReaction = dm17.removeReaction;
  const reactionsFor = useMemo(() => {
    const reactCache = new Map<string, (input: ReactInput) => void>();
    const reactFor = (id: string) => {
      let fn = reactCache.get(id);
      if (!fn) {
        fn = (input: ReactInput) => {
          if (input.mineEventId) dm17RemoveReaction(input.mineEventId);
          else dm17React(id, dm17KindById.get(id) ?? KIND_DM_CHAT, input.content, input.emojiUrl);
        };
        reactCache.set(id, fn);
      }
      return fn;
    };
    const objCache = new Map<string, { tallies: ReactionTally[]; value: MessageReactions }>();
    return (id: string): MessageReactions => {
      const tallies = talliesById.get(id) ?? EMPTY_TALLIES;
      const hit = objCache.get(id);
      if (hit && hit.tallies === tallies) return hit.value;
      const value: MessageReactions = { tallies, react: reactFor(id) };
      objCache.set(id, { tallies, value });
      return value;
    };
  }, [talliesById, dm17React, dm17RemoveReaction, dm17KindById]);

  const dm17DeleteMessage = dm17.deleteMessage;
  const deleteMessage = useCallback(
    (event: ChatMsg) => {
      if (dm17Ids.has(event.id)) dm17DeleteMessage(event.id, event.kind);
    },
    [dm17Ids, dm17DeleteMessage],
  );

  // ── Backfill: both planes page independently; sum what they prepend. ──────
  const dm17LoadOlder = dm17.loadOlder;
  const loadOlder = useCallback(async () => {
    const [a, b] = await Promise.all([loadOlderKind4(), dm17LoadOlder()]);
    return a + b;
  }, [loadOlderKind4, dm17LoadOlder]);
  const hasMore = hasMoreKind4 || dm17.hasMore;
  const isLoadingOlder = isLoadingOlderKind4 || dm17.isLoadingOlder;

  const dm17Send = dm17.send;
  // NIP-17 is the plane whenever the private path is usable AND the peer isn't
  // pinned to legacy NIP-04 for this conversation. When pinned to legacy we
  // treat NIP-17 as disabled so the UI (composer vs notice, reactions, etc.)
  // reflects the kind-4 plane the user chose.
  const dm17Usable = dm17.canSend;
  const dm17Enabled = dm17Usable && pref !== "nip04";
  const sendText = useCallback(
    async (text: string, tags?: string[][], opts?: { allowLegacy?: boolean }) => {
      // Explicit per-conversation pin to legacy NIP-04: a deliberate, persisted
      // choice, so route kind-4 directly (no LegacyFallbackRequired dance).
      if (pref === "nip04") {
        await sendKind4(text);
        return;
      }
      if (dm17Usable) {
        // Drop group-scoping tags the composer builds for relay chats; keep
        // content tags (imeta/q/emoji) inside the sealed rumor.
        const extraTags = (tags ?? []).filter(([name]) => name !== "h" && name !== "p");
        await dm17Send(text, extraTags);
      } else if (opts?.allowLegacy) {
        // Explicit user opt-in only: kind-4 is a privacy downgrade, never the
        // silent default (see LegacyFallbackRequired).
        await sendKind4(text);
      } else {
        throw new LegacyFallbackRequired();
      }
    },
    [pref, dm17Usable, dm17Send, sendKind4],
  );

  const isLoadingMerged = isLoading || dm17.isLoading;

  const transport = useMemo<ChatTransport>(
    () => ({
      messages: chatMessages,
      isLoading: isLoadingMerged,
      canWrite: true,
      canModerate: false,
      loadOlder,
      hasMore,
      isLoadingOlder,
      sendStatusFor,
      retry: retryById,
      discard,
      reactionsFor: dm17Enabled || talliesById.size > 0 ? reactionsFor : undefined,
      deleteMessage: dm17Enabled ? deleteMessage : undefined,
    }),
    [chatMessages, isLoadingMerged, loadOlder, hasMore, isLoadingOlder, sendStatusFor, retryById, discard, reactionsFor, deleteMessage, dm17Enabled, talliesById.size],
  );

  return {
    transport,
    encryptedIds,
    dm17Ids,
    dm17Enabled,
    dm17DeliveryGuaranteed: dm17.hasPeerInbox,
    decryptVisible,
    decryptOne,
    decryptAll,
    decryptDeclined,
    hasEncrypted,
    canDm17: dm17Enabled,
    legacyPinned: pref === "nip04",
    send: sendText,
  };
}

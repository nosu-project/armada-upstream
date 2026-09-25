import { useCallback, useMemo, useRef } from "react";

import { sameReactionTallies, toChatMsg } from "@/components/chat/transport";
import { KIND_DM, useDirectMessages } from "@/hooks/useDirectMessages";
import { useDm17Thread } from "@/hooks/useDm17";
import { useDmProtocolPref } from "@/hooks/useDmProtocolPref";
import { reactionContentKey } from "@/hooks/useReactions";
import { dmTimerSeconds, KIND_DM_CHAT } from "@/lib/nip17/protocol";
import { useCurrentUser } from "@/hooks/useCurrentUser";

import type { ChannelTimelineEntry } from "@/components/chat/channelTimeline";
import type { ChatMsg, ChatTransport, MessageReactions, ReactInput, ReactionTally, SendStatus } from "@/components/chat/transport";
import type { DecryptedDM } from "@/hooks/useDirectMessages";
import type { OpenedDm } from "@/lib/nip17/protocol";

/** Shared empty tally array, so messages with no reactions keep a stable prop. */
const EMPTY_TALLIES: ReactionTally[] = [];

/**
 * The merged timeline's skeleton gate.
 *
 * A DM thread is two INDEPENDENTLY-loading planes merged into one list, and
 * the skeleton replaces the scroller outright — so OR-ing the two `isLoading`
 * flags let either plane hide the other's messages. In practice that was
 * one-directional and constant: a modern conversation lives entirely on the
 * NIP-17 plane, its kind-4 half therefore reads zero rows locally, and the
 * kind-4 half's `isLoading` used to stay true for the whole of its first relay
 * pull. Every rumor could be folded and ready and the view still showed a
 * placeholder thread until a network round for messages that do not exist
 * finished — worst on a cold Android launch from a notification tap, where the
 * relays are unauthenticated and the pull runs to its 8s timeout.
 *
 * So: whatever is painted, paint it. The skeleton means "nothing to show yet
 * and a local read is still running", which is the only claim it can honestly
 * make — a plane still reading will drop its rows into the merge when it lands.
 *
 * One extra hold, and only one: until NIP-17's first LOCAL paint has resolved
 * (`dm17FirstPaintReady`). The two planes seed their first frame asymmetrically
 * — kind-4 from a SYNCHRONOUS localStorage snapshot (frame 0), NIP-17 from an
 * async KV prewarm a hop later — so a thread living on both planes would flash
 * its kind-4 half alone and then reflow as the NIP-17 rows dropped in beneath
 * it. Holding the merged skeleton across that one hop lets both snapshots paint
 * together. It is bounded by the PREWARM's single KV read (hit or miss), never
 * the store read's first-of-session legacy drain — the flag flips the moment
 * the prewarm settles, so this can never resurrect the stuck-skeleton the rest
 * of this gate exists to prevent.
 */
export function shouldShowDmTimelineLoading(
  mergedMessageCount: number,
  kind4Loading: boolean,
  dm17Loading: boolean,
  dm17FirstPaintReady: boolean,
): boolean {
  if (!dm17FirstPaintReady) return true;
  if (mergedMessageCount > 0) return false;
  return kind4Loading || dm17Loading;
}

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
 * Build a {@link ChatTransport} for a DM thread, so DMs render through the
 * same `MessageTimeline` / `ChatMessage` path as NIP-29 groups and Concord
 * communities instead of a bespoke timeline.
 *
 * A GROUP conversation is NIP-17 only: kind-4 is a pairwise cipher with no
 * group form, so the legacy plane is not merged, not offered, and cannot be
 * fallen back to — `legacyPeer` is undefined for anything with more than one
 * participant and every kind-4 input below degenerates to empty.
 *
 * The thread is the MERGE of two planes:
 *
 *   - Legacy kind-4 (NIP-04) events — Armada's historical DM plane, still
 *     read/written for peers that haven't published a NIP-17 inbox.
 *   - NIP-17 gift-wrapped rumors (kind 14/15) — the modern plane, with
 *     reactions (kind-7 rumors), deletes (kind-5 rumors), and optional NIP-17
 *     replacement edits in-band.
 *
 * Sends prefer NIP-17 whenever the peer has published a kind-10050 DM-relay
 * list (the spec's "ready to receive" signal) and the signer does NIP-44.
 * When the peer is NOT NIP-17-reachable, the legacy kind-4 plane is the only
 * option — but it's a privacy downgrade (kind-4 leaks who's talking and when),
 * so it is NEVER used silently: `send` refuses with `LegacyFallbackRequired`
 * and the caller must opt in explicitly (`send(text, tags, { allowLegacy })`)
 * after telling the user. Reactions/deletes/edits exist only on the NIP-17 plane.
 *
 * Two kind-4-specific concerns the shared timeline can't model are surfaced
 * alongside the transport for the page's `renderMessage` to handle:
 *   - `encryptedIds`: kind-4 ids whose plaintext hasn't been decrypted yet
 *     (NIP-17 rumors are stored decrypted — never placeholders).
 *   - `decryptVisible`: decrypt a placeholder by id (IntersectionObserver).
 */
export function useDmTransport(
  conversation: string,
  peers: readonly string[],
  focusedRumorId?: string,
): {
  transport: ChatTransport;
  /**
   * The merged timeline as generalized entries: chat rows plus the
   * disappearing-messages timer changes, chronologically interleaved. Passed
   * to `MessageTimeline`'s `entries` so the notices render in the feed the way
   * Signal's do.
   */
  entries: ChannelTimelineEntry[];
  /**
   * Whether a catch-up is still running over an EMPTY thread, so "no messages"
   * isn't a verdict yet. Deliberately not part of `transport.isLoading` (the
   * skeleton stands for the local read alone): the timeline takes this as its
   * own prop and says "Catching up…" in place of the empty state, exactly as a
   * Concord channel does.
   */
  syncing: boolean;
  /**
   * The conversation's disappearing-messages timer in seconds (0 = off), and
   * the setter either participant uses to change it. NIP-17 plane only —
   * legacy kind-4 has no in-band channel for conversation state.
   */
  disappearingTimer: number;
  setDisappearingTimer: (seconds: number) => void;
  /** Ids of kind-4 messages still awaiting lazy decryption (placeholder rows). */
  encryptedIds: Set<string>;
  /** Ids of NIP-17 rumors (unsigned; the page passes the `rumor` menu prop). */
  dm17Ids: Set<string>;
  /**
   * Whether sends go over NIP-17. True when the private plane is usable and
   * the per-conversation preference isn't pinned to legacy NIP-04.
   */
  dm17Enabled: boolean;
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
  // The one peer the legacy plane can address. Undefined for a group, which
  // takes every kind-4 branch below to its empty case.
  const legacyPeer = peers.length === 1 ? peers[0] : undefined;
  const {
    messages,
    isLoading,
    syncing,
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
  } = useDirectMessages(legacyPeer);

  const dm17 = useDm17Thread(conversation, focusedRumorId);
  const self = user?.pubkey;
  // A group has no legacy plane to pin to, so it is never "pinned to NIP-04"
  // however the first participant's own 1:1 preference happens to be set.
  const { pref: peerPref } = useDmProtocolPref(legacyPeer ?? "");
  const pref = legacyPeer ? peerPref : "auto";

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
                renderKey: m.renderKey,
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
  // Read through a ref by the per-message actions below. `dm17Ids` is rebuilt
  // with every page of history, and an action that depended on it changed
  // identity with it — handing every own row a new `onDelete` (and the rest)
  // on each scroll-back page, which re-rendered the whole loaded thread.
  const dm17IdsRef = useRef(dm17Ids);
  dm17IdsRef.current = dm17Ids;
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

  // Chat rows + timer-change notices, chronologically. Built here rather than
  // in the page so the two planes' merge stays in one place; a thread that has
  // never had a timer produces no extra entries at all.
  const dm17TimerChanges = dm17.timerChanges;
  const entries = useMemo<ChannelTimelineEntry[]>(() => {
    const out: ChannelTimelineEntry[] = chatMessages.map((message) => ({
      type: "chat" as const,
      id: `chat:${message.id}`,
      createdAt: message.created_at,
      message,
    }));
    for (const change of dm17TimerChanges) {
      const seconds = dmTimerSeconds(change);
      // A timer rumor we can't read is not a change to show — never guess
      // "off", which would misreport the conversation's state to the user.
      if (seconds === undefined) continue;
      out.push({
        type: "dm-timer",
        id: `dm-timer:${change.rumorId}`,
        createdAt: change.createdAt,
        author: change.author,
        seconds,
      });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }, [chatMessages, dm17TimerChanges]);

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
      if (dm17IdsRef.current.has(event.id)) dm17.retry(event.id);
      else retryKind4(event.id);
    },
    [dm17.retry, retryKind4], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const discard = useCallback(
    (id: string) => {
      if (dm17IdsRef.current.has(id)) dm17.discard(id);
    },
    [dm17.discard], // eslint-disable-line react-hooks/exhaustive-deps
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
  // Both caches outlive a recompute of `talliesById`, which rebuilds EVERY
  // tally array whenever any reaction in the thread changes (and whenever a
  // page of history lands). Rebuilding the per-row objects with it handed every
  // memoized message row a new `reactions` prop, so one reaction — or one
  // scroll-back page — re-rendered the whole thread.
  const reactDeps = useRef({ dm17React, dm17RemoveReaction, dm17KindById });
  reactDeps.current = { dm17React, dm17RemoveReaction, dm17KindById };
  const reactCache = useRef(new Map<string, (input: ReactInput) => void>());
  const reactionCache = useRef(new Map<string, MessageReactions>());
  const reactionsFor = useMemo(() => {
    // The react fn reads its collaborators through a ref, so it is stable per
    // message id for the life of the transport.
    const reactFor = (id: string) => {
      let fn = reactCache.current.get(id);
      if (!fn) {
        fn = (input: ReactInput) => {
          const deps = reactDeps.current;
          if (input.mineEventId) deps.dm17RemoveReaction(input.mineEventId);
          else deps.dm17React(id, deps.dm17KindById.get(id) ?? KIND_DM_CHAT, input.content, input.emojiUrl);
        };
        reactCache.current.set(id, fn);
      }
      return fn;
    };
    return (id: string): MessageReactions => {
      const tallies = talliesById.get(id) ?? EMPTY_TALLIES;
      const hit = reactionCache.current.get(id);
      if (hit && sameReactionTallies(hit.tallies, tallies)) return hit;
      const value: MessageReactions = { tallies, react: reactFor(id) };
      reactionCache.current.set(id, value);
      return value;
    };
  }, [talliesById]);

  const dm17DeleteMessage = dm17.deleteMessage;
  const deleteMessage = useCallback(
    (event: ChatMsg) => {
      if (dm17IdsRef.current.has(event.id)) dm17DeleteMessage(event.id, event.kind);
    },
    [dm17DeleteMessage],
  );

  const dm17EditMessage = dm17.editMessage;
  const editMessage = useCallback(
    async (original: ChatMsg, content: string) => {
      if (!dm17IdsRef.current.has(original.id) || original.kind !== KIND_DM_CHAT) {
        throw new Error("Only NIP-17 chat messages can be edited");
      }
      await dm17EditMessage(original.id, content);
    },
    [dm17EditMessage],
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
      if (pref === "nip04" && legacyPeer) {
        await sendKind4(text);
        return;
      }
      if (dm17Usable) {
        // Drop group-scoping tags the composer builds for relay chats, and the
        // composer's own `p` mentions — the rumor's `p` set IS the room under
        // NIP-17, so a mention smuggled in there would silently move the
        // message into a different conversation. Content tags (imeta/q/emoji)
        // ride inside the sealed rumor unchanged.
        const extraTags = (tags ?? []).filter(([name]) => name !== "h" && name !== "p");
        await dm17Send(text, extraTags);
      } else if (opts?.allowLegacy && legacyPeer) {
        // Explicit user opt-in only: kind-4 is a privacy downgrade, never the
        // silent default (see LegacyFallbackRequired).
        await sendKind4(text);
      } else {
        throw new LegacyFallbackRequired();
      }
    },
    [pref, dm17Usable, dm17Send, sendKind4, legacyPeer],
  );

  const isLoadingMerged = shouldShowDmTimelineLoading(
    chatMessages.length,
    isLoading,
    dm17.isLoading,
    dm17.firstPaintReady,
  );

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
      editMessage: dm17Enabled ? editMessage : undefined,
    }),
    [chatMessages, isLoadingMerged, loadOlder, hasMore, isLoadingOlder, sendStatusFor, retryById, discard, reactionsFor, deleteMessage, editMessage, dm17Enabled, talliesById.size],
  );

  return {
    transport,
    entries,
    syncing,
    disappearingTimer: dm17.timer ?? 0,
    setDisappearingTimer: dm17.setTimer,
    encryptedIds,
    dm17Ids,
    dm17Enabled,
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

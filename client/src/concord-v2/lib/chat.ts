/**
 * Concord V2 Chat Plane — CORD-03.
 *
 * A Channel's messages, reactions, edits, and deletes are ordinary rumors
 * inside encrypted seals at the Channel's stream address (one per held epoch,
 * so history spanning a rekey stays continuous). Each rumor MUST commit
 * `["channel", id]` + `["epoch", n]`, checked strict-equal against the
 * coordinate whose key decrypted the wrap (CORD-03 §3).
 *
 * Decoding (two NIP-44 opens + a Schnorr verify per wrap) is memoized per wrap
 * id and chunked off the main thread, so re-reading the append-only local
 * store costs near-nothing after the first pass.
 */

import type { NostrEvent } from "nostr-tools/pure";

import { KIND_DELETE, KIND_EDIT, KIND_MESSAGE, KIND_REACTION } from "@/concord-v2/lib/kinds";
import { checkChannelBinding, openWrap, type OpenedEvent } from "@/concord-v2/lib/stream";
import type { ChannelV2 } from "@/concord-v2/lib/types";

/** An opened chat event with its verified channel/epoch coordinate. */
export interface OpenedChat extends OpenedEvent {
  channelIdHex: string;
  epoch: bigint;
}

// ── Decode-once cache ────────────────────────────────────────────────────────

/** `wrapId|channelIdHex` → opened (or null = remembered failure). Session-scoped.
 *  Keyed per channel so one channel's "not my key" can't poison another's decode. */
const decodeMemo = new Map<string, OpenedChat | null>();
/** Memo keys that failed as "no held stream key" — retryable after a rekey catch-up. */
const skippedNoKey = new Set<string>();

/** Forget remembered no-key failures (a caught-up rekey may now decode them). */
export function forgetChatSkips(): void {
  for (const id of skippedNoKey) decodeMemo.delete(id);
  skippedNoKey.clear();
}

function openOne(wrap: NostrEvent, channel: ChannelV2): OpenedChat | null {
  const memoKey = `${wrap.id}|${channel.idHex}`;
  const cached = decodeMemo.get(memoKey);
  if (cached !== undefined) return cached;

  const stream = channel.streams.find((s) => s.group.pk === wrap.pubkey);
  if (!stream) {
    decodeMemo.set(memoKey, null);
    skippedNoKey.add(memoKey);
    return null;
  }
  let opened: OpenedChat | null = null;
  try {
    const ev = openWrap(wrap, stream.group);
    checkChannelBinding(ev, channel.idHex, stream.epoch);
    opened = { ...ev, channelIdHex: channel.idHex, epoch: stream.epoch };
  } catch {
    opened = null;
  }
  decodeMemo.set(memoKey, opened);
  return opened;
}

/** How many wraps to decode per main-thread slice. */
const DECODE_CHUNK = 25;

/**
 * Open a batch of sealed wraps for one channel, memoized and chunked off the
 * main thread so a large first decode never freezes the UI. Skips (foreign
 * epochs, malformed, spliced) are silent, as in Vector's read path.
 */
export async function openChatBatch(
  wraps: NostrEvent[],
  channel: ChannelV2,
  opts?: { signal?: AbortSignal },
): Promise<OpenedChat[]> {
  const out: OpenedChat[] = [];
  for (let i = 0; i < wraps.length; i += DECODE_CHUNK) {
    if (opts?.signal?.aborted) break;
    for (const wrap of wraps.slice(i, i + DECODE_CHUNK)) {
      const opened = openOne(wrap, channel);
      if (opened) out.push(opened);
    }
    // Yield between chunks (only when more work remains).
    if (i + DECODE_CHUNK < wraps.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return out;
}

// ── Tag helpers ──────────────────────────────────────────────────────────────

/** A reply quotes its parent with a `q` tag citing the parent RUMOR id (NIP-C7). */
export function replyTargetOf(ev: { tags: string[][] }): string | undefined {
  return ev.tags.find((t) => t[0] === "q")?.[1];
}

/** Reactions / edits / deletes name their target rumor with an `e` tag. */
export function eTargetOf(ev: { tags: string[][] }): string | undefined {
  return ev.tags.find((t) => t[0] === "e")?.[1];
}

// ── Timeline fold ────────────────────────────────────────────────────────────

/** Moderation context the read path applies while folding. */
export interface ChatModeration {
  /** Banned author pubkeys — every event from them is dropped (CORD-04 §4). */
  banned: Set<string>;
  /** Whether `deleter` may delete a message by `author` (MANAGE_MESSAGES). */
  canDelete: (deleter: string, author: string) => boolean;
}

/** A tallied reaction: reactors plus the NIP-30 custom-emoji URL (if any). */
export interface ReactionEntry {
  reactors: Set<string>;
  url?: string;
}

export interface FoldedTimeline {
  /** Surviving messages, sorted by ms ascending. */
  messages: OpenedChat[];
  /** target rumor id → emoji → tally. */
  reactions: Map<string, Map<string, ReactionEntry>>;
}

/**
 * Fold a batch of opened chat events into the channel timeline: drop banned
 * authors, apply edits (author-only, latest by ms), and tally reactions per
 * target.
 *
 * Deletes are DELETES, not hides: a kind-5 rumor physically removes its target
 * from the rumor cache on write (self-delete via the store's NIP-09; a
 * moderator delete is authorized against the roster at the write site before it
 * reaches the store). So a folded set read back from the cache never contains a
 * deleted message. The delete pass here is only a belt-and-suspenders for
 * IN-BATCH deletes — an optimistic or just-arrived kind-5 folded alongside its
 * target before the store's async removal has committed — and applies the same
 * authorization (self, or a `canDelete` moderator) so the two paths agree.
 */
export function foldTimeline(opened: OpenedChat[], moderation?: ChatModeration): FoldedTimeline {
  const byId = new Map<string, OpenedChat>();
  const deletes = new Map<string, Set<string>>();
  // ALL edits per target (author validity is judged against the message in the
  // apply phase — otherwise a non-author's later "edit" would suppress the
  // author's legitimate one).
  const edits = new Map<string, Array<{ author: string; content: string; ms: number }>>();
  const reactions = new Map<string, Map<string, ReactionEntry>>();

  for (const ev of opened) {
    if (moderation?.banned.has(ev.author)) continue;

    if (ev.kind === KIND_DELETE) {
      // NIP-09 shape: possibly several `e` targets.
      for (const t of ev.tags) {
        if (t[0] !== "e" || !t[1]) continue;
        let authors = deletes.get(t[1]);
        if (!authors) deletes.set(t[1], (authors = new Set()));
        authors.add(ev.author);
      }
      continue;
    }
    if (ev.kind === KIND_EDIT) {
      const target = eTargetOf(ev);
      if (!target) continue;
      let list = edits.get(target);
      if (!list) edits.set(target, (list = []));
      list.push({ author: ev.author, content: ev.content, ms: ev.ms });
      continue;
    }
    if (ev.kind === KIND_REACTION) {
      const target = eTargetOf(ev);
      if (!target || !ev.content) continue;
      const url = ev.tags.find((t) => t[0] === "emoji")?.[2];
      let byEmoji = reactions.get(target);
      if (!byEmoji) reactions.set(target, (byEmoji = new Map()));
      let entry = byEmoji.get(ev.content);
      if (!entry) byEmoji.set(ev.content, (entry = { reactors: new Set() }));
      entry.reactors.add(ev.author);
      if (url && !entry.url) entry.url = url;
      continue;
    }
    if (ev.kind === KIND_MESSAGE) {
      byId.set(ev.rumorId, ev);
    }
  }

  // Edits: only the original author may edit; their latest (by ms) wins.
  for (const [id, list] of edits) {
    const msg = byId.get(id);
    if (!msg) continue;
    let best: { content: string; ms: number } | undefined;
    for (const e of list) {
      if (e.author !== msg.author) continue;
      if (!best || e.ms > best.ms) best = e;
    }
    if (best) byId.set(id, { ...msg, content: best.content });
  }

  // In-batch deletes: self-delete, or an authorized moderator delete.
  for (const [id, msg] of byId) {
    const deleters = deletes.get(id);
    if (!deleters) continue;
    const deleted =
      deleters.has(msg.author) ||
      (moderation && [...deleters].some((d) => moderation.canDelete(d, msg.author)));
    if (deleted) byId.delete(id);
  }

  return {
    messages: [...byId.values()].sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.rumorId < b.rumorId ? -1 : 1)),
    reactions,
  };
}

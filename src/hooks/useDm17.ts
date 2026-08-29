/**
 * NIP-17 direct messages — sync, thread, and conversation hooks.
 *
 * The modern DM plane beside the legacy kind-4 engine (`useDirectMessages`).
 * Wire format lives in `src/lib/nip17/protocol.ts` (classic NIP-17 envelope);
 * decrypted rumors persist in `src/lib/nip17/dm17Store.ts`. These hooks own the
 * relay traffic:
 *
 *   - INBOX SYNC: a throttled `{kinds:[1059], "#p":[me]}` top-up against the
 *     viewer's DM relays. Every new wrap is opened once (consent-gated for
 *     prompting signers — two nip44 decrypts per wrap) and the rumor is
 *     stored decrypted; the ciphertext is never persisted. The scan is
 *     since-scoped PER RELAY: each relay resumes from its own watermark, and
 *     the 2-day slack window (NIP-59 backdating) is paid on a relay's first
 *     pass of the session, periodically after, and on app resume; routine
 *     polls between use a narrow overlap (the wire's standing sub owns live
 *     delivery). A relay that fails a pass keeps its old watermark and stays
 *     retryable — another relay's progress is never attributed to it.
 *   - THREAD: local-first store read + the shared inbox sync; per-thread
 *     older-history backfill pages the global `#p` gift-wrap stream with
 *     `until`, decrypting each wrap to sort it into its conversation.
 *   - SEND: rumor → two seals (peer + self copy) → two wraps, published to
 *     the peer's kind-10050 inbox relays and the viewer's own DM relays
 *     respectively (NIP-17 publishing rules). Sends are optimistic: the rumor
 *     id is computable synchronously, so the row renders before the signer is
 *     even asked, with pending/failed status + retry.
 *
 * Sending is gated on the peer having PUBLISHED a kind-10050 list — the
 * spec's explicit "ready to receive" signal. Callers fall back to kind-4 for
 * everyone else (see useDmTransport).
 */

import { useNostr } from "@nostrify/react";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { useDmRelayList, useDmRelaysForAll } from "@/hooks/useDmRelayList";
import { useEventStore } from "@/hooks/useEventStore";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { useResumeEpoch } from "@/hooks/useResumeEpoch";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { APP_RELAYS, normalizeRelayUrl } from "@/lib/platform";
import { mayBulkDecrypt, signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { getDecryptConsent } from "@/lib/decryptConsent";
import { isDmSynced, markDmSynced } from "@/lib/dmSynced";
import { STORE_READ } from "@/lib/storeQuery";
import { logSync } from "@/lib/syncLog";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import {
  buildDmEditRumors,
  buildDmRumor,
  DM_RUMOR_KINDS,
  dmChatTags,
  dmConvKey,
  dmConvPeers,
  dmDeleteTags,
  dmReactionTags,
  dmTimerTags,
  dmWebxdcTags,
  expirationOf,
  isExpired,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_FILE,
  KIND_DM_PEER_SIGNAL,
  KIND_DM_REACTION,
  KIND_DM_TIMER,
  KIND_DM_WEBXDC,
  KIND_DM_WRAP,
  MAX_WRAP_BACKDATE_SECS,
  openDmWrap,
  sealDmRumor,
  wrapDmSeal,
  type Dm17Signer,
  type DmWebxdcMeta,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import type { NostrRumor } from "@/lib/nostrRumor";
import {
  DM17_SEEN_CAP,
  drainLiveDmWraps,
  hasBufferedLiveDmWraps,
  queryDm17Conversations,
  queryDm17Rumor,
  queryDm17Thread,
  queryDm17Timer,
  readDm17Cursor,
  readDm17SeenWrapIds,
  rebufferLiveDmWraps,
  sweepExpiredDm17Rumors,
  updateDm17Cursor,
  writeDm17Rumors,
  writeDm17SeenWrapIds,
  type Dm17ConversationRow,
  type Dm17Cursor,
} from "@/lib/nip17/dm17Store";
import { persistDm17ThreadSnapshot, prewarmDm17ThreadSnapshot } from "@/lib/nip17/threadSnapshot";
import {
  parseDmPeerSignal,
  peerSignalContent,
  type PeerSignalEvent,
} from "@/lib/webxdcRealtime";
import { useWireScopes } from "@/wire/useWireScopes";
import { dmThreadScope, emitWireScopes } from "@/wire/bus";
import { dm17NotifyCandidates, feedNotifyCandidates } from "@/wire/notify";

import type { SendStatus } from "@/hooks/useGroupMessages";
import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";

/** Minimum interval between inbox relay scans (wire-bus invalidations stay local). */
const SYNC_MIN_INTERVAL_MS = 30_000;
/** Wraps are backdated ≤ 2 days; a FULL scan re-reads this far behind the cursor. */
const RESYNC_SLACK_SECS = MAX_WRAP_BACKDATE_SECS + 3600;
/**
 * Slack for the routine polls BETWEEN full scans. The full backdate window
 * exists because a wrap's `created_at` lies up to 2 days in the past — but
 * re-fetching that whole window every 30-60s re-transferred the same
 * ciphertext page over and over (the seen-memo only skips the re-decrypt).
 * Live delivery is the wire's standing sub (whose own `since` rewinds the full
 * window); the narrow poll only needs to cover the cursor-advance races around
 * it. A backdated wrap that arrived while the wire was deaf is recovered by
 * the next FULL scan, at most {@link FULL_SCAN_INTERVAL_MS} away.
 */
const NARROW_RESYNC_SLACK_SECS = 10 * 60;
/** How often an inbox pass pays the full backdate window again. */
const FULL_SCAN_INTERVAL_MS = 15 * 60_000;
/** Per-viewer + relay time of the last COMPLETED full-window scan. */
const lastFullScanAt = new Map<string, number>();
/** Minimum time away for a return to count as a resume (vs. an alt-tab). */
const RESUME_MIN_AWAY_MS = 30_000;
/** Avoid paying the full recovery window twice for one resume/reconnect burst. */
const FOREGROUND_SYNC_MIN_MS = 30_000;
const lastForegroundSyncAt = new Map<string, number>();
/** Newest wraps fetched per inbox scan / backfill page. */
const INBOX_PAGE = 500;
/** Wraps decrypted per wave in openAndStore (yields between waves). */
const DECRYPT_WAVE = 4;
/** Rumors read per thread window. */
const THREAD_WINDOW = 300;
/** Minimum interval between expired-rumor sweeps (see sweepExpiredDm17Rumors). */
const SWEEP_MIN_INTERVAL_MS = 60_000;

let lastSweepAt = 0;

/**
 * Physically drop rumors whose NIP-40 deadline passed while they sat in the
 * store. Throttled and fire-and-forget: every DM surface calls it, and a miss
 * costs nothing (read paths filter expired rumors regardless).
 */
function sweepExpiredSoon(self: string): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepExpiredDm17Rumors(self).catch(() => undefined);
}

/** Whether the current signer can do NIP-17 (NIP-44 encrypt/decrypt). */
export function useDm17Support(): boolean {
  const { user } = useCurrentUser();
  return !!user?.signer.nip44;
}

/** One DM-relay auto-adopt attempt per (session, pubkey) — see useAdoptDmInbox. */
const dmRelaysAdopted = new Set<string>();

/**
 * Read/write DMs where the viewer DECLARED: when they HAVE a published
 * kind-10050 list but "use my own DM relays" is off and they've never
 * customized the DM-relay set, adopt the published list into local config and
 * flip the toggle on. The user's declared inbox is the canonical place their
 * DMs live, so it should be the default read/write set — otherwise DMs land on
 * their 10050 relays but we read from the app relays. A deliberate later
 * toggle-off / custom list is preserved (we only auto-adopt the untouched
 * default, once per session).
 *
 * This hook NEVER publishes anything. The client must not write a user's
 * kind-10050 list without an explicit action: the read that would gate an
 * auto-publish can come back empty on a cold pool / wrong relay set / timeout,
 * and publishing a "first" list then REPLACES the user's real one everywhere
 * (10050 is a replaceable event). A user with no published list stays
 * unpublished until they save DM relays in Settings; NIP-17 senders fall back
 * to kind-4 for them.
 */
export function useAdoptDmInbox(): void {
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const { hasList, isLoading, relays: publishedRelays } = useDmRelayList();
  const publishedKey = publishedRelays.join(",");

  // Adopt a published 10050 as the user's own DM relays when they haven't
  // opted in and haven't customized the (app-relay-default) list.
  useEffect(() => {
    const self = user?.pubkey;
    if (!self || isLoading || !hasList || publishedRelays.length === 0) return;
    if (config.useOwnDmRelays) return;
    // Only adopt an untouched default — never clobber a deliberate custom list.
    const isDefaultDmRelays =
      config.dmRelays.length === APP_RELAYS.length &&
      config.dmRelays.every((r, i) => r === APP_RELAYS[i]);
    if (!isDefaultDmRelays) return;
    if (dmRelaysAdopted.has(self)) return;
    dmRelaysAdopted.add(self);
    updateConfig((current) => ({
      ...current,
      useOwnDmRelays: true,
      dmRelays: publishedRelays,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, isLoading, hasList, publishedKey, config.useOwnDmRelays]);
}

// ── Inbox sync ────────────────────────────────────────────────────────────────

type NostrPool = ReturnType<typeof useNostr>["nostr"];

interface SyncCtx {
  nostr: NostrPool;
  signer: NostrSigner;
  self: string;
  method: string | undefined;
  relays: string[];
}

interface SyncOpts {
  force?: boolean;
  interactive?: boolean;
  /** Rewind every relay through the full NIP-59 backdate window. */
  full?: boolean;
}

/** Per-viewer sync throttling + seen wrap ids (skip re-decrypt churn). */
const lastSyncAt = new Map<string, number>();
const lastSyncDeclined = new Map<string, boolean>();
/** In-flight inbox passes per viewer, so concurrent callers await the same one. */
const inflightSync = new Map<string, { pass: Promise<boolean>; full: boolean }>();
const seenWrapIds = new Map<string, Set<string>>();
const seenWrapsLoaded = new Map<string, Promise<void>>();

function seenSetFor(self: string): Set<string> {
  let set = seenWrapIds.get(self);
  if (!set) seenWrapIds.set(self, (set = new Set()));
  return set;
}

/**
 * Union the persisted opened-wrap memo into the session seen set (once per
 * viewer). Must complete before any `seenSetFor` filter, or a cold launch
 * re-decrypts the whole slack window it already opened last session.
 */
function loadSeenWraps(self: string): Promise<void> {
  let p = seenWrapsLoaded.get(self);
  if (!p) {
    p = readDm17SeenWrapIds(self)
      .then((ids) => {
        if (!ids) return;
        const seen = seenSetFor(self);
        for (const id of ids) seen.add(id);
      })
      .catch(() => undefined);
    seenWrapsLoaded.set(self, p);
  }
  return p;
}

/**
 * Persist the seen set (evicting the oldest half past the cap). Gated behind
 * the load so a write can never clobber persisted ids with a partial set.
 */
function persistSeenWraps(self: string): void {
  void loadSeenWraps(self).then(() => {
    const seen = seenSetFor(self);
    if (seen.size > DM17_SEEN_CAP) {
      let drop = seen.size - (DM17_SEEN_CAP >> 1);
      for (const id of seen) {
        if (drop-- <= 0) break;
        seen.delete(id);
      }
    }
    return writeDm17SeenWrapIds(self, seen);
  }).catch(() => undefined);
}

// ── Mini App peer signals (Vector's DM realtime discovery) ──────────────────
//
// A peer signal is a kind-30078 rumor inside an ordinary gift wrap, naming an
// iroh node address for one Mini App topic. It is LIVE data — the address it
// carries is meaningless once that session ends — so it is never stored, and
// no relay query asks for the bare kind: a kind-30078 addressed to us that
// arrived outside a wrap proves only that someone can spell our pubkey, and
// admitting it would let any author put a node into our dial set.

/** Wire scope for one conversation's Mini App peer signals. */
export function dmWebxdcPeerScope(conversation: string, topic: string): string {
  return `dm:webxdc-peer:${conversation}:${topic}`;
}

/** Every DM peer signal, whatever the conversation or topic. */
export const DM_WEBXDC_PEER_SCOPE = "dm:webxdc-peer";

/** Recent peer signals, keyed by conversation and topic. */
const dmPeerSignalStore = new Map<string, PeerSignalEvent[]>();
const DM_PEER_SIGNAL_MAX = 100;

function peerSignalKey(conversation: string, topic: string): string {
  return `${conversation}\u0000${topic}`;
}

/**
 * The signals one conversation has carried for one topic, in the shape
 * {@link foldPeerSignals} reads.
 *
 * Keyed by the CONVERSATION as well as the topic. A topic is minted per send
 * so two conversations do not collide by accident, but "who is playing" is a
 * question about a room: a signal that arrived in one DM must not put its
 * author into a session opened from another.
 */
export function getDmPeerSignals(conversation: string, topic: string): PeerSignalEvent[] {
  return dmPeerSignalStore.get(peerSignalKey(conversation, topic)) ?? [];
}

/**
 * Read a peer signal out of an opened rumor and hand it to whichever session
 * is listening. Vector's DM spelling (the operation is the CONTENT, the topic
 * and address are tags) is converted to the one canonical fold input here, so
 * the DM and Concord planes are folded by the same code.
 */
function dispatchDmPeerSignal(dm: OpenedDm): void {
  const signal = parseDmPeerSignal(dm.content, dm.tags);
  if (!signal) return;
  const conversation = dmConvKey(dm.peers);
  if (!conversation) return;

  const key = peerSignalKey(conversation, signal.topic);
  const existing = dmPeerSignalStore.get(key) ?? [];
  existing.push({
    author: dm.author,
    content: peerSignalContent(signal.topic, signal.op === "ad" ? signal.addr : undefined),
    ms: dm.createdAt * 1000,
  });
  if (existing.length > DM_PEER_SIGNAL_MAX) {
    existing.splice(0, existing.length - DM_PEER_SIGNAL_MAX);
  }
  dmPeerSignalStore.set(key, existing);

  emitWireScopes([dmWebxdcPeerScope(conversation, signal.topic), DM_WEBXDC_PEER_SCOPE]);
}

/**
 * Open a batch of wraps (consent-gated) and persist the recovered DM rumors.
 * Returns false when the gate declined/deferred (nothing was consumed).
 *
 * Non-interactive consumers (the always-mounted unread dot) must never be the
 * thing that pops the one-time decrypt-consent prompt: when the signer can
 * prompt and consent is not yet "allowed", a background sync DEFERS instead
 * of asking — the prompt surfaces the first time the user actually opens DMs
 * (matching the kind-4 previews' opt-in behavior).
 */
async function openAndStore(ctx: SyncCtx, wraps: NostrEvent[], interactive: boolean): Promise<boolean> {
  if (wraps.length === 0) return true;
  const needsApproval = signerNeedsApproval(ctx.method);
  if (!interactive && needsApproval && getDecryptConsent() !== "allowed") {
    lastSyncDeclined.set(ctx.self, true);
    return false;
  }
  const targets = wraps.map((w) => ({ counterparty: w.pubkey, ciphertext: w.content }));
  if (!(await mayBulkDecrypt(ctx.signer, "nip44", targets, needsApproval))) {
    lastSyncDeclined.set(ctx.self, true);
    return false;
  }
  lastSyncDeclined.set(ctx.self, false);

  const seen = seenSetFor(ctx.self);
  const opened: OpenedDm[] = [];
  const peerSignals: OpenedDm[] = [];

  // Bounded waves, never one unthrottled Promise.all: each wrap costs two
  // NIP-44 opens (synchronous noble crypto for local signers), so a full
  // cold-scan page as one microtask-chained batch blocks the main thread for
  // seconds. A small wave still pipelines remote (bunker) signers; the
  // setTimeout(0) between waves yields the event loop.
  for (let i = 0; i < wraps.length; i += DECRYPT_WAVE) {
    await Promise.all(
      wraps.slice(i, i + DECRYPT_WAVE).map(async (wrap) => {
        const dm = await openDmWrap(wrap, ctx.signer as Dm17Signer, ctx.self);
        seen.add(wrap.id);
        if (!dm) return;
        // A Mini App peer signal is live routing, not history: collected here
        // and dispatched below rather than stored.
        if (dm.kind === KIND_DM_PEER_SIGNAL) {
          peerSignals.push(dm);
          return;
        }
        // Foreign rumor kinds (e.g. Concord direct invites, kind 3313) are not
        // ours to store — their own scan paths handle them.
        if (DM_RUMOR_KINDS.includes(dm.kind)) opened.push(dm);
      }),
    );
    if (i + DECRYPT_WAVE < wraps.length) await new Promise((r) => setTimeout(r, 0));
  }

  await writeDm17Rumors(ctx.self, opened);
  feedNotifyCandidates(dm17NotifyCandidates(opened, ctx.self));
  persistSeenWraps(ctx.self);
  for (const signal of peerSignals) dispatchDmPeerSignal(signal);

  return true;
}

/**
 * Decrypt DM gift wraps the wire buffered from its live subscription — the
 * fast live path. The wraps are already in hand (the wire received them on its
 * standing kind-1059 sub), so this does NO relay round-trip: it drains the
 * buffer and opens the ciphertext directly, eliminating the re-fetch (and its
 * NIP-42 auth re-handshake) that made live DMs lag ~10-20s.
 *
 * Returns "consumed" when the drained wraps are handled (new rumors stored, or
 * everything already decrypted by an earlier pass/poll — nothing outstanding
 * either way), "empty" when the buffer held nothing at all (a spurious ring or
 * an overflowed buffer), or "deferred" when the consent gate declined (the
 * wraps are re-buffered for the interactive retry / poll backstop). Callers
 * fall back to a forced inbox fetch only on "empty" — so a lost wrap is never
 * stranded until the 60s poll, and a mere replay never re-queries the relays.
 *
 * Concurrent callers COALESCE onto one pass: the interactive thread and the
 * DMs page both listen on `dm:wrap`, and the drain is destructive — racing it
 * would hand one of them an empty buffer (and a needless fallback fetch).
 * Only INTERACTIVE surfaces should call this: a non-interactive consumer would
 * consume the buffer just to defer on the consent gate.
 */
let liveDm17Pass: Promise<"consumed" | "empty" | "deferred"> | undefined;

export async function openLiveDm17Wraps(
  ctx: SyncCtx,
  opts?: { interactive?: boolean },
): Promise<"consumed" | "empty" | "deferred"> {
  const prior = liveDm17Pass;
  if (prior) {
    const result = await prior;
    // A wrap buffered while the shared pass ran still needs a drain — go
    // again. Never loop on "deferred": the decline re-buffered the wraps, and
    // re-running would spin on the consent gate.
    if (result === "deferred" || !hasBufferedLiveDmWraps()) return result;
    return openLiveDm17Wraps(ctx, opts);
  }
  const pass = runLiveDm17Pass(ctx, opts);
  liveDm17Pass = pass;
  try {
    return await pass;
  } finally {
    liveDm17Pass = undefined;
  }
}

async function runLiveDm17Pass(
  ctx: SyncCtx,
  opts?: { interactive?: boolean },
): Promise<"consumed" | "empty" | "deferred"> {
  if (!ctx.self || !ctx.signer.nip44) return "empty";
  const wraps = drainLiveDmWraps();
  if (wraps.length === 0) return "empty";
  await loadSeenWraps(ctx.self);
  const seen = seenSetFor(ctx.self);
  const fresh = wraps.filter((w) => !seen.has(w.id));
  // Everything drained was already decrypted (an earlier pass, the poll, or a
  // backfill beat us to it) — handled, NOT "empty": no fallback fetch needed.
  if (fresh.length === 0) return "consumed";
  // openAndStore is consent-gated and writes the recovered rumors (ringing
  // `dm`). On decline, re-buffer so the next interactive pass / poll retries.
  if (!(await openAndStore(ctx, fresh, opts?.interactive ?? false))) {
    rebufferLiveDmWraps(fresh);
    return "deferred";
  }
  // No cursor write: inbox scans resume from per-relay watermarks, and the
  // live buffer carries no relay attribution to raise one with.
  return "consumed";
}

/**
 * Top up the viewer's gift-wrap inbox from their DM relays. Throttled per
 * viewer; a consent decline leaves the cursor unadvanced so the wraps are
 * retried once consent flips.
 */
export async function syncDm17Inbox(ctx: SyncCtx, opts?: SyncOpts): Promise<boolean> {
  if (!ctx.self || !ctx.signer.nip44 || ctx.relays.length === 0) return false;
  // Concurrent callers coalesce onto ONE pass. The unread dot and the DMs page
  // each mount their own conversations query, so both call this on a cold
  // start; without this the loser returns immediately on the throttle below
  // while the winner is still fetching, and a first sync waiting on it would
  // resolve against a store the pass hasn't filled yet.
  const inflight = inflightSync.get(ctx.self);
  if (inflight) {
    const result = await inflight.pass;
    // A foreground recovery must not disappear behind a routine narrow poll
    // that happened to be in flight when the app resumed. Let that pass finish,
    // then pay the requested full window once.
    if (opts?.full && !inflight.full) {
      // The owner normally clears this in its `finally`, but two await
      // continuations may resume in either order. Clear only the pass we just
      // awaited so the recursive full run cannot keep finding a settled narrow
      // pass; the owner's identity check below cannot delete the replacement.
      if (inflightSync.get(ctx.self) === inflight) inflightSync.delete(ctx.self);
      return syncDm17Inbox(ctx, { ...opts, force: true });
    }
    return result;
  }
  const now = Date.now();
  const last = lastSyncAt.get(ctx.self) ?? 0;
  // A deferred/declined pass left wraps unconsumed: bypass the throttle only
  // once decrypting could actually succeed now — consent flipped to allowed,
  // or an interactive surface (which may open the one-time prompt) is asking.
  const retryDeclined =
    (lastSyncDeclined.get(ctx.self) ?? false) &&
    (opts?.interactive || getDecryptConsent() === "allowed" || !signerNeedsApproval(ctx.method));
  if (!opts?.force && !retryDeclined && now - last < SYNC_MIN_INTERVAL_MS) return false;
  lastSyncAt.set(ctx.self, now);

  const pass = runInboxSync(ctx, opts, now);
  inflightSync.set(ctx.self, { pass, full: opts?.full ?? false });
  try {
    return await pass;
  } finally {
    if (inflightSync.get(ctx.self)?.pass === pass) inflightSync.delete(ctx.self);
  }
}

/**
 * Read gift wraps from every inbox relay INDEPENDENTLY and merge them (deduped
 * by id — the same wrap lands on several of the user's relays).
 *
 * NOT `group(relays).query(...)`: the pooled group query aborts the WHOLE
 * fan-out `eoseTimeout` ms (300 in this app) after the FIRST relay EOSEs
 * (NPool.query forces the pool's eoseTimeout). A warm no-auth DM relay
 * (e.g. relay.primal.net) EOSEs almost instantly, guillotining any auth-gated
 * DM relay in the same set before it can finish its NIP-42
 * challenge→sign→re-REQ round-trip — so those relays' wraps are silently
 * dropped. That starves the APK (cold/reconnecting sockets need the handshake
 * every wake) far more than a long-lived desktop client whose gated sockets are
 * already authenticated and answer within 300ms.
 *
 * A per-relay `NRelay1.query` has no cross-relay timer: on `auth-required` it
 * waits for the AUTH handshake and re-sends the REQ, bounded only by `signal`
 * (NRelay1.receive → retrySubAfterAuth). So each relay gets the full budget and
 * a fast relay can never starve a slow one.
 */
export interface Dm17RelayPage {
  url: string;
  events: NostrEvent[];
}

export interface Dm17RelayQueryResult {
  /** Relays whose query reached EOSE, including successful empty results. */
  pages: Dm17RelayPage[];
  /** Failed/timed-out relays. Their cursor must remain untouched. */
  failed: string[];
}

export async function queryWrapsPerRelay(
  nostr: NostrPool,
  relays: string[],
  filter: NostrFilter | ((url: string) => NostrFilter),
  signal: AbortSignal,
): Promise<Dm17RelayQueryResult> {
  const settled = await Promise.allSettled(
    relays.map(async (url): Promise<Dm17RelayPage> => ({
      url,
      events: await nostr.relay(url).query(
        [typeof filter === "function" ? filter(url) : filter],
        { signal },
      ),
    })),
  );
  const pages: Dm17RelayPage[] = [];
  const failed: string[] = [];
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") pages.push(result.value);
    else failed.push(relays[i]);
  }
  return { pages, failed };
}

/** Deduplicate the same wrap returned by more than one successful relay. */
function mergeRelayPages(pages: Dm17RelayPage[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const { events } of pages) {
    for (const event of events) byId.set(event.id, event);
  }
  return [...byId.values()];
}

/**
 * Watermark each successful page. A scan that completed at wall time S proves
 * any wrap PUBLISHED after S carries `created_at ≥ S − MAX_WRAP_BACKDATE_SECS`
 * (NIP-59 backdates, never forward-dates) — whatever the page contained. The
 * watermark is that floor, raised to the newest wrap the page actually
 * returned. An empty page therefore still bounds the next poll's window to
 * the backdate horizon, without ever advancing past a backdated wrap still
 * en route — which is what writing wall clock here would do.
 *
 * Only GIFT WRAPS raise it, and the kind check is the whole guarantee rather
 * than a formality: the floor is sound only because every event counted here
 * is backdated by at most the horizon. An event published at wall clock —
 * anything that is not a 1059 — would drag the watermark a full two days past
 * where a backdated wrap still in flight will land, and the next narrow poll
 * would simply not select it. That is a silently lost DM, so a page that
 * somehow carries another kind is watermarked as if it were empty.
 */
export function relayScanWatermarks(pages: Dm17RelayPage[], nowSecs: number): Record<string, number> {
  const floor = nowSecs - MAX_WRAP_BACKDATE_SECS;
  const out: Record<string, number> = {};
  for (const page of pages) {
    const backdated = page.events.filter((event) => event.kind === KIND_DM_WRAP);
    out[page.url] = Math.max(floor, ...backdated.map((event) => event.created_at));
  }
  return out;
}

/**
 * Build one relay's top-up filter from that relay's own successful progress.
 *
 * Gift wraps and nothing else. A Mini App peer signal rides INSIDE one of
 * these like every other DM rumor, so there is no second filter to ask for:
 * a bare kind-30078 addressed to us is an event any author can publish, and
 * asking for it would both admit unauthenticated node addresses into the dial
 * set and put a non-backdated event into the page {@link relayScanWatermarks}
 * reads.
 */
export function dm17InboxFilter(
  self: string,
  cursor: Dm17Cursor | undefined,
  relay: string,
  full: boolean,
): NostrFilter {
  const newest = cursor?.relayNewest?.[relay];
  const filter: NostrFilter = { kinds: [KIND_DM_WRAP], "#p": [self], limit: INBOX_PAGE };
  if (newest !== undefined) {
    const slack = full ? RESYNC_SLACK_SECS : NARROW_RESYNC_SLACK_SECS;
    filter.since = Math.max(0, newest - slack);
  }
  return filter;
}

/**
 * One inbox pass. Resolves true only when the relay query completed and its
 * wraps were consumed — a throw, or a consent deferral, resolves false so
 * callers never mistake a failed pass for "synced".
 */
async function runInboxSync(
  ctx: SyncCtx,
  opts: SyncOpts | undefined,
  now: number,
): Promise<boolean> {
  try {
    const [cursor] = await Promise.all([readDm17Cursor(ctx.self), loadSeenWraps(ctx.self)]);
    // Full-window cadence is PER RELAY. A relay that failed the last pass (or
    // has no per-relay cursor after upgrading from the old global cursor) must
    // not inherit another relay's progress and silently skip its own wraps.
    const fullRelays = new Set(
      ctx.relays.filter((relay) => {
        const key = `${ctx.self}\u0000${relay}`;
        return opts?.full || cursor?.relayNewest?.[relay] === undefined ||
          now - (lastFullScanAt.get(key) ?? 0) >= FULL_SCAN_INTERVAL_MS;
      }),
    );
    const result = await queryWrapsPerRelay(
      ctx.nostr,
      ctx.relays,
      (relay) => dm17InboxFilter(ctx.self, cursor, relay, fullRelays.has(relay)),
      AbortSignal.timeout(8000),
    );
    if (result.pages.length === 0) {
      logSync("dm", `inbox scan failed on all ${ctx.relays.length} relay(s)`);
      return false;
    }
    if (result.failed.length > 0) {
      logSync("dm", `inbox scan reached ${result.pages.length}/${ctx.relays.length} relay(s); ${result.failed.length} remain retryable`);
    }

    const wraps = mergeRelayPages(result.pages);
    const seen = seenSetFor(ctx.self);
    const fresh = wraps.filter((w) => !seen.has(w.id));

    if (!(await openAndStore(ctx, fresh, opts?.interactive ?? false))) return false; // deferred: retry later
    // Only successful + consumed relay pages advance their watermark (see
    // relayScanWatermarks for why an empty page advances to the backdate floor
    // and not to wall clock). A timed-out relay keeps its previous watermark
    // (or none) and remains a full-scan candidate.
    const nowSecs = Math.floor(now / 1000);
    const relayNewest = relayScanWatermarks(result.pages, nowSecs);
    for (const page of result.pages) {
      if (fullRelays.has(page.url)) {
        lastFullScanAt.set(`${ctx.self}\u0000${page.url}`, now);
      }
    }
    if (wraps.length > 0) {
      const newest = Math.max(...wraps.map((w) => w.created_at));
      const oldest = Math.min(...wraps.map((w) => w.created_at));
      await updateDm17Cursor(ctx.self, {
        newest,
        relayNewest,
        // First full scan seeds the backfill floor; a short page means the
        // relays had nothing deeper.
        ...(cursor ? {} : {
          oldest,
          exhausted: result.failed.length === 0 && result.pages.every((page) => page.events.length < INBOX_PAGE),
        }),
      }, { pruneRelaysTo: ctx.relays });
    } else {
      await updateDm17Cursor(ctx.self, {
        relayNewest,
        ...(cursor ? {} : {
          newest: nowSecs,
          oldest: nowSecs,
          exhausted: result.failed.length === 0,
        }),
      }, { pruneRelaysTo: ctx.relays });
    }
    return true;
  } catch {
    // Best-effort background sync; local-first reads already rendered.
    return false;
  }
}

/**
 * Page the global `#p` gift-wrap stream one page older than `until`, opening
 * and storing whatever comes back. Returns the new floor and whether the
 * relays appear to be out of history.
 *
 * The stream is global on purpose — a wrap's author is ephemeral, so there is
 * no per-peer filter to narrow it with. Every backfill page therefore pulls
 * older history for EVERY correspondent at once, which is what lets the
 * conversation list recover senders it has never seen.
 *
 * `exhausted` is an inference, not a fact: a relay that silently caps our
 * `limit` returns a short page that looks identical to running out. Callers
 * that latch it must be able to un-latch (see useDm17Backfill).
 */
async function pageOlderDmWraps(
  ctx: SyncCtx,
  until: number,
  interactive: boolean,
): Promise<{ oldest?: number; exhausted: boolean; scanned: number }> {
  const result = await queryWrapsPerRelay(
    ctx.nostr,
    ctx.relays,
    { kinds: [KIND_DM_WRAP], "#p": [ctx.self], until, limit: INBOX_PAGE },
    AbortSignal.timeout(8000),
  );
  // No successful relay is not an empty page. Throw so callers leave their
  // session's `hasMore` latch open and a later press retries the same range.
  if (result.pages.length === 0) throw new Error("DM backfill failed on every relay");
  const wraps = mergeRelayPages(result.pages);
  if (wraps.length === 0) {
    return { exhausted: result.failed.length === 0, scanned: 0 };
  }
  const oldest = Math.min(...wraps.map((w) => w.created_at)) - 1;
  await loadSeenWraps(ctx.self);
  const seen = seenSetFor(ctx.self);
  await openAndStore(
    ctx,
    wraps.filter((w) => !seen.has(w.id)),
    interactive,
  );
  await updateDm17Cursor(ctx.self, { oldest });
  return {
    oldest,
    exhausted: result.failed.length === 0 && result.pages.every((page) => page.events.length < INBOX_PAGE),
    scanned: wraps.length,
  };
}

/** Build the stable sync context for the current viewer (or undefined). */
function useDm17SyncCtx(): SyncCtx | undefined {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  // Read wraps from the union of our effective DM relays AND our PUBLISHED
  // kind-10050 inbox. NIP-17 senders deliver to whatever we published in our
  // 10050; if the user hasn't opted into "use my own DM relays",
  // effectiveDmRelays is just the app relays and we'd miss wraps that landed
  // on our declared inbox. Unioning both is where our messages actually are.
  const { relays: publishedRelays } = useDmRelayList();
  // Normalized so one relay spelled two ways (trailing slash, uppercase host)
  // can't dial twice or fork the persisted per-relay watermark: config URLs
  // arrive raw, while the published 10050 half is already normalized.
  const relays = useMemo(
    () =>
      [...new Set(
        [...effectiveDmRelays(config), ...publishedRelays]
          .map((url) => normalizeRelayUrl(url))
          .filter((url): url is string => url !== undefined),
      )],
    [config, publishedRelays],
  );
  const relayKey = relays.join(",");
  return useMemo(() => {
    if (!user?.pubkey || !user.signer.nip44) return undefined;
    return { nostr, signer: user.signer, self: user.pubkey, method: user.method, relays };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user, relayKey]);
}

/**
 * Recover the DM inbox when a suspended client becomes usable again.
 *
 * The standing wire subscription is the low-latency path, but a mobile WebView
 * or browser can return with that socket dead. NIP-59 backdates gift wraps by
 * up to two days, so an ordinary narrow poll is not a safe resume operation.
 * This hook is mounted once by DmSyncLifecycle.
 *
 * "The app came back" is read from React Query's focusManager via
 * useResumeEpoch — the one seam already driven from Capacitor's authoritative
 * appStateChange on native (see App.tsx) and the browser's visibility events
 * on web — rather than a second set of listeners that could disagree with it
 * (see useResumeEpoch's header). The away floor keeps an alt-tab from paying
 * the full recovery window. Regaining connectivity doesn't flip focus, so the
 * same recovery also subscribes to onlineManager, the seam
 * `refetchOnReconnect` already uses.
 */
export function useDm17ForegroundSync(): void {
  const ctx = useDm17SyncCtx();
  const epoch = useResumeEpoch(RESUME_MIN_AWAY_MS);

  useEffect(() => {
    if (!ctx) return;

    const recover = () => {
      const now = Date.now();
      if (now - (lastForegroundSyncAt.get(ctx.self) ?? 0) < FOREGROUND_SYNC_MIN_MS) return;
      lastForegroundSyncAt.set(ctx.self, now);
      void syncDm17Inbox(ctx, { force: true, full: true, interactive: false });
    };

    if (epoch > 0) recover();
    return onlineManager.subscribe((online) => {
      if (online) recover();
    });
  }, [ctx, epoch]);
}

// ── Thread ────────────────────────────────────────────────────────────────────

/** An optimistic (not yet relay-confirmed) outgoing rumor. */
interface PendingRumor {
  opened: OpenedDm;
  /**
   * `undefined` means confirmed: published and written to the store, but the
   * store-backed query hasn't repainted with it yet. The row keeps rendering
   * from here (with no send badge) until it does — see the prune effect in
   * `useDm17Thread`.
   */
  status: SendStatus | undefined;
  /**
   * A composite operation retried/discarded as one unit. NIP-17 edits are a
   * replacement plus a kind-5 tombstone; keeping both here prevents retrying
   * only half an edit after a transient relay failure.
   */
  batch?: PendingPublish[];
}

interface PendingPublish {
  rumor: NostrRumor;
  opened: OpenedDm;
  opts?: { firstContact?: boolean };
}

export interface Dm17Thread {
  /** Chat/file rumors, deletes applied, ascending (oldest first). */
  messages: OpenedDm[];
  /** Reaction rumors grouped by their `e` target id (deletes applied). */
  reactionsByTarget: Map<string, OpenedDm[]>;
  /**
   * Disappearing-messages timer changes inside the loaded window, ascending —
   * the feed renders one notice row per change (Signal-style). The live
   * setting is {@link timer}, which is read independently of this window.
   */
  timerChanges: OpenedDm[];
  /**
   * The conversation's disappearing-messages timer in seconds; 0 (or
   * undefined, before the store has been read) means off. Set by EITHER
   * participant — newest change wins.
   */
  timer: number | undefined;
  /**
   * Change the conversation's timer (0 turns it off) and tell the peer. Both
   * sides' outgoing messages then carry `sent_at + seconds` as their NIP-40
   * expiration.
   */
  setTimer: (seconds: number) => void;
  isLoading: boolean;
  /**
   * Whether NIP-17's first LOCAL paint has resolved — the snapshot prewarm has
   * had its one KV read (hit or miss), or the store read landed first. The
   * merged DM timeline holds its skeleton until this so a thread living on both
   * planes doesn't paint its synchronously-seeded kind-4 half a frame ahead of
   * the NIP-17 half. Bounded by the prewarm, never the store read's
   * first-of-session legacy drain.
   */
  firstPaintReady: boolean;
  /**
   * Whether NIP-17 sends to this peer are possible: the signer does NIP-44
   * and we have somewhere to publish the gift wrap — the peer's published
   * kind-10050 inbox, or (when they have none) our own app/DM relays as a
   * best-effort fallback. When false, callers use the kind-4 path.
   */
  canSend: boolean;
  /** Send a chat message (kind 14). Resolves once optimistically rendered. */
  send: (content: string, extraTags?: string[][]) => Promise<void>;
  /**
   * Publish one Mini App state update (kind 3310) into this conversation,
   * scoped to `uuid` — the session the attachment named.
   *
   * The metadata is webxdc's own `sendUpdate` payload and is passed as FIELDS
   * rather than as pre-built tags: a caller that hands over tags has to be
   * trusted to have built them the way this rumor's kind requires, and the one
   * that did was silently losing all three.
   */
  sendWebxdc: (uuid: string, payload: string, meta?: DmWebxdcMeta) => Promise<void>;
  /** Send a kind-7 reaction targeting a message in this conversation. */
  react: (targetId: string, targetKind: number, content: string, emojiUrl?: string) => void;
  /** Retract an own reaction (kind-5 delete of the reaction rumor). */
  removeReaction: (reactionRumorId: string) => void;
  /** Delete an own message (kind-5 delete rumor into the conversation). */
  deleteMessage: (targetId: string, targetKind: number) => void;
  /** Edit an own kind-14 message using NIP-17's replacement + delete pair. */
  editMessage: (targetId: string, content: string) => Promise<void>;
  /** Optimistic delivery status for a rumor id. */
  sendStatusFor: (id: string) => SendStatus | undefined;
  /** Re-publish a failed optimistic rumor. */
  retry: (id: string) => void;
  /** Drop a failed optimistic rumor. */
  discard: (id: string) => void;
  loadOlder: () => Promise<number>;
  hasMore: boolean;
  isLoadingOlder: boolean;
}

/**
 * The decrypted NIP-17 thread with one conversation, plus send/react/delete.
 *
 * `conversation` is a conversation KEY (see `dmConvKey`): a single pubkey for a
 * 1:1 or Note to Self, several comma-joined for a group. Everything below works
 * off the participant list it decodes to, so the 1:1 and group paths are one
 * path — the only place the two differ is how many seals a send mints.
 *
 * `focusedRumorId` is an optional local-store hit (for example from message
 * search) that should be admitted even when it lies behind the newest-first
 * thread window. It does not move the history cursor or widen ordinary reads.
 */
export function useDm17Thread(
  conversation: string | undefined,
  focusedRumorId?: string,
): Dm17Thread {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const ctx = useDm17SyncCtx();
  const { consent } = useDecryptConsent();
  const support = useDm17Support();
  const eventStore = useEventStore();

  const self = user?.pubkey;
  const peers = useMemo(
    () => (conversation ? dmConvPeers(conversation) : []),
    [conversation],
  );
  // Who a wrap actually has to be minted for: the participants minus us. Empty
  // for Note to Self, whose only copy IS the self copy.
  const recipients = useMemo(
    () => peers.filter((peer) => peer !== self),
    [peers, self],
  );
  const inboxRelays = useDmRelaysForAll(recipients);
  // Where OUR copies live and where our other sessions read: the same union the
  // inbox sync uses (effective DM relays ∪ our published kind-10050 inbox).
  const myRelays = ctx?.relays ?? effectiveDmRelays(config);

  // NIP-17 send is possible when the signer does NIP-44 and we have SOMEWHERE
  // to publish the gift wraps. The spec's canonical target is each recipient's
  // published kind-10050 inbox; when they have none we fall back to our own
  // (app / DM) relays — fully private (still gift-wrapped, no metadata leak),
  // and reachable whenever they read those shared relays (the common Armada
  // case). This is a routing fact, not a trustworthy user-readiness or
  // delivery-status signal: older clients (including Ditto) never published
  // kind 10050 even when the conversation worked over shared relays.
  const hasPeerInbox = recipients.some((peer) => (inboxRelays.get(peer)?.length ?? 0) > 0);
  const canSend = support && peers.length > 0 && (hasPeerInbox || myRelays.length > 0);

  // Optimistic outgoing rumors (pending/failed), keyed by rumor id. Confirmed
  // sends land in the store and drop out of here.
  const [pending, setPending] = useState<Map<string, PendingRumor>>(new Map());
  useEffect(() => setPending(new Map()), [self, conversation]);

  const queryKey = useMemo(
    () => ["dm17", "thread", self, conversation, consent] as const,
    [self, conversation, consent],
  );

  // The store query starts bounded, then grows monotonically as explicit
  // backfill pages land. Keeping the limit in a ref gives every later poll /
  // focus refetch the same floor; a fixed THREAD_WINDOW refetch used to discard
  // the rows loadOlder had just stored, making a DM appear unable to cross the
  // first dense day of history.
  const threadWindowRef = useRef<{
    self: string | undefined;
    conversation: string | undefined;
    limit: number;
  }>({ self, conversation, limit: THREAD_WINDOW });
  if (
    threadWindowRef.current.self !== self ||
    threadWindowRef.current.conversation !== conversation
  ) {
    threadWindowRef.current = { self, conversation, limit: THREAD_WINDOW };
  }

  // Whether the NIP-17 store read is enabled — i.e. this plane can actually
  // contribute rows. Single-sourced with the query below so the skeleton gate
  // and the query can never disagree about whether NIP-17 is coming.
  const queryEnabled = !!self && peers.length > 0 && support;
  // Which query key's snapshot prewarm has SETTLED (one KV read, hit or miss).
  // Recorded here, but readiness is DERIVED at render time (below) rather than
  // stored — because a stored flag set from the effect lagged a render: it was
  // still `true` from the pre-login phase (no user yet on a cold tab, so
  // `support` reads false) on the very render `support` flipped true, and the
  // kind-4 half — seeded SYNCHRONOUSLY from localStorage — painted alone for
  // that one frame before the effect could re-arm the gate. That leak is the
  // flicker that survived on a fresh tab.
  const prewarmKey = useMemo(() => JSON.stringify(queryKey), [queryKey]);
  const [prewarmSettledKey, setPrewarmSettledKey] = useState<string | null>(null);

  // Paint the last window from KV while the store read runs. The read is
  // enabled on this very render, but it awaits the legacy drain and merges two
  // 300-row filters; the snapshot is one KV row, so it lands first and the real
  // data replaces it (seeded stale — see threadSnapshot).
  useEffect(() => {
    if (!queryEnabled) return;
    let cancelled = false;
    void prewarmDm17ThreadSnapshot(queryClient, self!, conversation!, queryKey).finally(() => {
      if (!cancelled) setPrewarmSettledKey(prewarmKey);
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient, self, conversation, queryEnabled, queryKey, prewarmKey]);

  // NIP-17's first local paint has "resolved" when the plane either cannot
  // contribute rows at all (disabled — no self/peer/NIP-44) or its snapshot
  // prewarm has settled for THIS query key. DERIVED at render time rather than
  // stored so the disabled→enabled flip recomputes it to `false` on the very
  // render `support` turns true — the render on which the kind-4 half's
  // synchronous localStorage seed also first appears. A stored flag set from an
  // effect could not: it kept the pre-login `true` for that one frame and let
  // the kind-4 half paint alone, which is the flicker that survived on a fresh
  // tab.
  const firstPaintReady = !queryEnabled || prewarmSettledKey === prewarmKey;

  const query = useQuery<OpenedDm[]>({
    queryKey,
    // Store read (the inbox scan below is fired, not awaited), so: no retry
    // ladder holding `isPending` — and therefore the timeline's skeleton — over
    // rumors that are already on disk. See storeQuery.
    ...STORE_READ,
    enabled: queryEnabled,
    queryFn: async ({ signal }) => {
      // LOCAL-FIRST: the store paints immediately; the inbox scan tops up in
      // the background (throttled) and rings the `dm` scope on new rumors.
      const window = threadWindowRef.current;
      const before = queryClient.getQueryData<OpenedDm[]>(queryKey) ?? [];
      let rows = await queryDm17Thread(self!, peers, {
        limit: window.limit,
        signal,
      });
      // Once history has filled the window, a new live rumor would otherwise
      // take one slot from its newest edge and silently evict the oldest row on
      // every poll. Grow by the newly-seen rows and re-read, so refetching never
      // undoes history the reader explicitly paged into view. The second read is
      // paid only when a full window actually receives something new.
      if (before.length >= window.limit) {
        const beforeIds = new Set(before.map((row) => row.rumorId));
        const incoming = rows.reduce(
          (count, row) => count + (beforeIds.has(row.rumorId) ? 0 : 1),
          0,
        );
        if (incoming > 0) {
          window.limit += incoming;
          rows = await queryDm17Thread(self!, peers, { limit: window.limit, signal });
        }
      }
      if (ctx) void syncDm17Inbox(ctx, { interactive: true });
      sweepExpiredSoon(self!);
      return rows.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    },
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // A focused result can be much older than the growing window. Read that one
  // rumor by id and merge it only into the render fold below. Keeping it out of
  // `query.data` means a normal refetch cannot shrink it away, and—equally
  // importantly—it cannot drag the older-history cursor past the gap between it
  // and the newest loaded page.
  const focusedQuery = useQuery<OpenedDm | undefined>({
    queryKey: ["dm17", "thread-focus", self, conversation, focusedRumorId ?? null],
    ...STORE_READ,
    enabled: !!self && peers.length > 0 && !!focusedRumorId && support,
    queryFn: ({ signal }) => queryDm17Rumor(self!, peers, focusedRumorId!, { signal }),
    staleTime: 10_000,
  });

  // The live disappearing-messages timer, read on its own so a setting made
  // beyond the thread window is still in force (see queryDm17Timer). Shares
  // the thread's invalidation: a timer rumor lands through the same `dm` ring.
  const timerQueryKey = useMemo(
    () => ["dm17", "timer", self, conversation] as const,
    [self, conversation],
  );
  const timerQuery = useQuery<number>({
    queryKey: timerQueryKey,
    enabled: !!self && peers.length > 0 && support,
    queryFn: async ({ signal }) => (await queryDm17Timer(self!, peers, { signal })) ?? 0,
    staleTime: 10_000,
  });
  const timer = timerQuery.data;

  // Two DM doorbells:
  //   - `dm:wrap` — the wire buffered live inbound NIP-17 gift wrap(s) it can't
  //     decrypt (needs our signer + consent gate). Decrypt the IN-HAND wraps
  //     directly — no relay round-trip, so the message streams in ~instantly
  //     instead of re-fetching (which re-paid NIP-42 auth: the ~10-20s lag).
  //     Concurrent surfaces coalesce onto one pass (see openLiveDm17Wraps); a
  //     genuinely EMPTY buffer (overflow / spurious ring) falls back to a
  //     forced fetch so a lost wrap is never stranded until the poll.
  //   - `dm-thread:<peer>` — a durable write changed this conversation. Re-read
  //     only; never decrypt again (that would loop on the write's own ring).
  useWireScopes((scopes) => {
    if (!self || !conversation) return;
    if (ctx && scopes.has("dm:wrap")) {
      void openLiveDm17Wraps(ctx, { interactive: true }).then((result) => {
        if (result === "empty") void syncDm17Inbox(ctx, { force: true, interactive: true });
      });
    }
    // Opening a live wrap writes the recovered rumor first, and that durable
    // write rings this conversation-specific scope. Do not also re-read on
    // `dm:wrap` before there is anything new in the store.
    if (scopes.has(dmThreadScope(conversation))) {
      void queryClient.invalidateQueries({ queryKey });
      // A timer change arrives as an ordinary rumor, so the same ring covers it.
      void queryClient.invalidateQueries({ queryKey: timerQueryKey });
    }
  });

  // A disappearing message must leave the screen the moment its deadline
  // passes, not at the next refetch. `expiryTick` re-runs the fold; the effect
  // below schedules it for the earliest deadline still in the future.
  const [expiryTick, setExpiryTick] = useState(0);

  // Fold: store rows + optimistic rows (deduped by rumor id), deletes applied
  // (belt & suspenders — the store already physically removes self-deletes),
  // expired rumors dropped, split into the message timeline, per-target
  // reactions and the timer-change notices.
  const { messages, reactionsByTarget, timerChanges, nextExpiry } = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const byId = new Map<string, OpenedDm>();
    for (const r of query.data ?? []) byId.set(r.rumorId, r);
    if (focusedQuery.data) byId.set(focusedQuery.data.rumorId, focusedQuery.data);
    for (const p of pending.values()) if (!byId.has(p.opened.rumorId)) byId.set(p.opened.rumorId, p.opened);

    const deleted = new Set<string>();
    for (const r of byId.values()) {
      if (r.kind !== KIND_DM_DELETE) continue;
      for (const [name, value] of r.tags) {
        if (name !== "e" || !value) continue;
        const target = byId.get(value);
        if (!target || target.author === r.author) deleted.add(value);
      }
    }

    const messages: OpenedDm[] = [];
    const reactionsByTarget = new Map<string, OpenedDm[]>();
    const timerChanges: OpenedDm[] = [];
    // The soonest deadline still ahead of us, so the tick can be scheduled for
    // exactly that moment instead of polling.
    let nextExpiry: number | undefined;
    for (const r of byId.values()) {
      if (deleted.has(r.rumorId)) continue;
      // Client-side enforcement, independent of what the store handed back:
      // an expired rumor is never rendered, whatever route it arrived by.
      if (isExpired(r.tags, now)) continue;
      const at = expirationOf(r.tags);
      if (at !== undefined && (nextExpiry === undefined || at < nextExpiry)) nextExpiry = at;
      if (r.kind === KIND_DM_CHAT || r.kind === KIND_DM_FILE) {
        messages.push(r);
      } else if (r.kind === KIND_DM_WEBXDC) {
        // Filter out kind 3310 webxdc updates so they don't appear in the chat
        // but are still visible to the webxdc app (read by useDmAppSync).
      } else if (r.kind === KIND_DM_REACTION) {
        const target = r.tags.find(([n, v]) => n === "e" && v)?.[1];
        if (!target) continue;
        const list = reactionsByTarget.get(target) ?? [];
        list.push(r);
        reactionsByTarget.set(target, list);
      } else if (r.kind === KIND_DM_TIMER) {
        timerChanges.push(r);
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    timerChanges.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    return { messages, reactionsByTarget, timerChanges, nextExpiry };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, focusedQuery.data, pending, expiryTick]);

  // Re-fold exactly when the next message expires (and sweep it off disk).
  // setTimeout is clamped to ~24.8 days by the 32-bit delay; a longer deadline
  // just re-arms on the next fold, which the poll/refetch guarantees.
  useEffect(() => {
    if (nextExpiry === undefined) return;
    const delay = Math.min(nextExpiry * 1000 - Date.now(), 2 ** 31 - 1);
    const id = setTimeout(() => {
      if (self) sweepExpiredSoon(self);
      setExpiryTick((t) => t + 1);
    }, Math.max(0, delay));
    return () => clearTimeout(id);
  }, [nextExpiry, self]);

  const setStatus = useCallback((id: string, status: SendStatus | undefined) => {
    setPending((old) => {
      const entry = old.get(id);
      if (!entry) return old;
      const next = new Map(old);
      next.set(id, { ...entry, status });
      return next;
    });
  }, []);

  /** Forget an optimistic rumor entirely (discard, or superseded by the store). */
  const dropPending = useCallback((id: string) => {
    setPending((old) => {
      const entry = old.get(id);
      if (!entry) return old;
      const next = new Map(old);
      for (const item of entry.batch ?? []) next.delete(item.rumor.id);
      next.delete(id);
      return next;
    });
  }, []);

  // Retire confirmed optimistic rows only once the store-backed query actually
  // contains them. Dropping one at publish time instead left a visible hole:
  // the store write rings the `dm` scope, but that ring is debounced by the
  // wire bus and the repaint then costs an IndexedDB read, so the row was
  // removed and re-inserted tens of milliseconds later on every send. The fold
  // above dedupes by rumor id, so holding the row here renders it exactly once.
  useEffect(() => {
    const rows = query.data;
    if (!rows || rows.length === 0) return;
    setPending((old) => {
      if (old.size === 0) return old;
      const stored = new Set(rows.map((r) => r.rumorId));
      let next: Map<string, PendingRumor> | undefined;
      for (const [id, entry] of old) {
        // A failed row is not in the store; it stays until retried or discarded.
        if (entry.status !== undefined || !stored.has(id)) continue;
        next ??= new Map(old);
        next.delete(id);
      }
      return next ?? old;
    });
  }, [query.data]);

  // Persist the newest window for the next cold open. The STORE rows only:
  // optimistic rows are not in the store, and a failed send must not come back
  // from a snapshot looking confirmed.
  useEffect(() => {
    if (!self || !conversation) return;
    const rows = query.data;
    if (!rows || rows.length === 0) return;
    void persistDm17ThreadSnapshot(self, conversation, rows);
  }, [self, conversation, query.data]);

  /**
   * Seal + wrap + publish one rumor: one copy PER recipient to that
   * recipient's kind-10050 inbox relays (NIP-17 publishing rule), plus the self
   * copy to the viewer's own DM relays. Resolves when every recipient copy is
   * accepted; the self copy is best-effort (the rumor is already in the local
   * store).
   *
   * A group costs N+1 seals, and they are SEQUENTIAL — NIP-07 extensions reject
   * concurrent signEvent calls, and a bunker serializes approvals anyway. That
   * is the real price of NIP-17 groups: a ten-person room is eleven signer
   * round-trips per message. The UI does not wait on it (sends are optimistic),
   * but the latency is genuinely there on a remote signer.
   *
   * Delivery is all-or-nothing from the caller's point of view: if any
   * recipient's publish fails the whole send is marked failed and retried as a
   * unit, which can re-deliver to recipients that already got it. Duplicate
   * wraps of the same rumor dedupe on the rumor id at every reader, so a
   * re-delivery is invisible; a partial success reported as a success would not
   * be.
   */
  const publishRumor = useCallback(
    async (rumor: NostrRumor, opts?: { firstContact?: boolean }) => {
      if (!user?.signer.nip44 || !self || peers.length === 0) {
        throw new Error("NIP-17 not available");
      }
      const signer = user.signer as unknown as Dm17Signer;

      // The rumor's own NIP-40 deadline rides all the way out: sealDmRumor
      // copies it onto the seal, and the wrap repeats it in the clear so
      // NIP-40-aware relays drop their stored copy too.
      const expiresAt = expirationOf(rumor.tags);

      // Sequential seals: NIP-07 extensions reject concurrent signEvent calls.
      const outgoing: Array<{ wrap: NostrEvent; targets: string[] }> = [];
      for (const recipient of recipients) {
        const seal = await sealDmRumor(rumor, recipient, signer);
        const wrap = wrapDmSeal(seal, recipient, {
          firstContact: opts?.firstContact,
          expiresAt,
        });
        // Deliver to their published inbox (NIP-17's rule) UNIONED with our own
        // DM relays. Their 10050 relays are where a compliant client reads, but
        // writing there ALSO requires us to reach them; adding our own relays
        // hedges against an inbox we can't publish to (auth, downtime) and lets
        // our other sessions / their fallback readers find the wrap. Deduped so
        // shared relays aren't double-published.
        outgoing.push({
          wrap,
          targets: [...new Set([...(inboxRelays.get(recipient) ?? []), ...myRelays])],
        });
      }
      const sealSelf = await sealDmRumor(rumor, self, signer);
      const wrapSelf = wrapDmSeal(sealSelf, self, { expiresAt });

      // Persist OUR self-addressed wrap locally BEFORE publishing. On Android
      // the event store is the same database the notification service dedupes
      // its kind-1059 inbox against, so when this wrap echoes back off the
      // relay it's recognized as already seen instead of firing a spurious
      // "New direct message".
      //
      // Mark before any relay publish. The content-blind push server cannot
      // distinguish an incoming wrap from our NIP-17 self-copy, but the service
      // worker can suppress this exact event id without seeing plaintext.
      await markOwnWebPushEvent(wrapSelf.id);
      await eventStore.then((s) => s.event(wrapSelf)).catch(() => undefined);

      // Note to Self has no recipients, so the self copy IS the send and its
      // publish is what "sent" means. Everywhere else it is fire-and-forget: it
      // exists for OTHER devices/sessions, and this device already has the
      // rumor locally.
      const selfPublish =
        myRelays.length > 0
          ? nostr.group(myRelays).event(wrapSelf, { signal: AbortSignal.timeout(8000) })
          : Promise.resolve();
      if (recipients.length === 0) {
        await selfPublish;
        return;
      }
      void selfPublish.catch(() => {});

      await Promise.all(
        outgoing.map(({ wrap, targets }) =>
          nostr.group(targets).event(wrap, { signal: AbortSignal.timeout(8000) }),
        ),
      );
    },
    [nostr, user, self, peers, recipients, inboxRelays, myRelays, eventStore],
  );

  /**
   * Optimistically render and sequentially publish one logical operation.
   * Most sends contain one rumor; an edit contains its replacement followed by
   * the tombstone. The visible row owns the whole batch for retry/discard.
   */
  const dispatchBatch = useCallback(
    (items: PendingPublish[], visibleId: string, supersededId?: string) => {
      setPending((old) => {
        const next = new Map(old);
        if (supersededId) next.delete(supersededId);
        for (const item of items) {
          next.set(item.rumor.id, {
            opened: item.opened,
            status: item.rumor.id === visibleId ? "pending" : undefined,
            batch: item.rumor.id === visibleId && items.length > 1 ? items : undefined,
          });
        }
        return next;
      });
      void (async () => {
        try {
          // Keep signer calls sequential: NIP-07 extensions commonly serialize
          // approval/signing, and an edit must not race its own tombstone.
          for (const item of items) await publishRumor(item.rumor, item.opts);
          // Durable + confirmed: persist and clear the send badge, but KEEP the
          // optimistic row. It is retired only once the query has actually read
          // it back (see the prune effect) — the store write's `dm` ring is
          // debounced and the repaint costs an IndexedDB read, so dropping it
          // here would blank the row for that whole window.
          if (self) await writeDm17Rumors(self, items.map((item) => item.opened));
          for (const item of items) setStatus(item.rumor.id, undefined);
        } catch {
          setStatus(visibleId, "failed");
        }
      })();
    },
    [publishRumor, setStatus, self],
  );

  /** Optimistically render a rumor, then seal/wrap/publish in the background. */
  const dispatchRumor = useCallback(
    (rumor: NostrRumor, opened: OpenedDm, opts?: { firstContact?: boolean }) => {
      dispatchBatch([{ rumor, opened, opts }], rumor.id);
    },
    [dispatchBatch],
  );

  const openedOf = useCallback(
    (rumor: NostrRumor): OpenedDm => ({
      rumorId: rumor.id,
      author: rumor.pubkey,
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      createdAt: rumor.created_at,
      peers,
      wrapId: "",
    }),
    [peers],
  );

  // The resolved timer, mirrored into a ref so a send can read the CURRENT
  // value without closing over a stale render.
  const timerRef = useRef<number | undefined>(undefined);
  timerRef.current = timer;

  /**
   * The conversation's timer, waiting on the store if the query hasn't landed.
   *
   * Never assume "off" from a not-yet-loaded query: the composer autofocuses on
   * opening a conversation, and the first IndexedDB read after a cold Android
   * WebView launch can take seconds — so a fast typist could otherwise put a
   * PERMANENT message into a conversation both people set to disappear. The
   * fallback read is a single indexed lookup and only ever runs on that race.
   */
  const resolveTimer = useCallback(async (): Promise<number> => {
    const known = timerRef.current;
    if (known !== undefined) return known;
    if (peers.length === 0 || !self) return 0;
    return (await queryDm17Timer(self, peers).catch(() => undefined)) ?? 0;
  }, [peers, self]);

  /** The NIP-40 deadline for something sent right now, or undefined when off. */
  const resolveExpiry = useCallback(async (): Promise<number | undefined> => {
    const seconds = await resolveTimer();
    return seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : undefined;
  }, [resolveTimer]);

  const send = useCallback(
    async (content: string, extraTags?: string[][]) => {
      if (!canSend || !self || peers.length === 0) {
        throw new Error("This conversation isn't reachable over private DMs yet.");
      }
      const trimmed = content.trim();
      if (!trimmed) return;
      const expiresAt = await resolveExpiry();
      const rumor = buildDmRumor({
        kind: KIND_DM_CHAT,
        content: trimmed,
        tags: dmChatTags(peers, { extraTags, expiresAt }),
        pubkey: self,
      });
      // First contact = nothing in this thread yet: add the outer `k` hint so
      // a k-aware receiver can index their cold inbox.
      dispatchRumor(rumor, openedOf(rumor), { firstContact: messages.length === 0 });
    },
    [canSend, self, peers, dispatchRumor, openedOf, messages.length, resolveExpiry],
  );

  /**
   * NIP-17 edit: replace the kind-14 at its original timestamp, then tombstone
   * its old id. The pair is one optimistic/retry unit so a failed relay round
   * trip never leaves the UI offering to retry only the replacement.
   */
  const editMessage = useCallback(
    async (targetId: string, content: string) => {
      if (!canSend || !self || peers.length === 0) {
        throw new Error("This conversation isn't reachable over private DMs yet.");
      }
      const original = messages.find((message) => message.rumorId === targetId);
      if (!original || original.author !== self || original.kind !== KIND_DM_CHAT) {
        throw new Error("Only your own NIP-17 chat messages can be edited");
      }
      const trimmed = content.trim();
      if (!trimmed || trimmed === original.content.trim()) return;

      const source: NostrRumor = {
        id: original.rumorId,
        kind: original.kind,
        content: original.content,
        tags: original.tags,
        created_at: original.createdAt,
        pubkey: original.author,
      };
      const { replacement, deletion } = buildDmEditRumors(source, peers, trimmed);
      const items: PendingPublish[] = [replacement, deletion].map((rumor) => ({
        rumor,
        opened: openedOf(rumor),
      }));
      // Publish the replacement first: if signing fails immediately, the peer
      // retains the original. The tombstone follows in the same retryable batch.
      dispatchBatch(items, replacement.id, original.rumorId);
    },
    [canSend, self, peers, messages, openedOf, dispatchBatch],
  );

  const react = useCallback(
    (targetId: string, targetKind: number, content: string, emojiUrl?: string) => {
      if (!canSend || !self || peers.length === 0) return;
      // Deferred by a microtask (or one store read on a cold open) so the
      // reaction inherits the same deadline a message sent now would get.
      void (async () => {
        const expiresAt = await resolveExpiry();
        const rumor = buildDmRumor({
          kind: KIND_DM_REACTION,
          content,
          tags: dmReactionTags(
            peers,
            targetId,
            targetKind,
            customEmojiReactionTags(content, emojiUrl),
            expiresAt,
          ),
          pubkey: self,
        });
        dispatchRumor(rumor, openedOf(rumor));
      })();
    },
    [canSend, self, peers, dispatchRumor, openedOf, resolveExpiry],
  );

  /**
   * Change the conversation's disappearing-messages timer. Written locally
   * first (so the notice row and the new timer apply immediately) and
   * published wrapped to the peer, exactly like a delete. Timer rumors carry
   * no expiration of their own — see KIND_DM_TIMER.
   */
  const setTimer = useCallback(
    (seconds: number) => {
      if (!canSend || !self || peers.length === 0) return;
      const next = Math.max(0, Math.floor(seconds));
      void (async () => {
        // Compare against the RESOLVED timer, not a possibly-unloaded one:
        // otherwise picking "Off" on a cold thread would silently no-op and
        // leave the conversation disappearing.
        if ((await resolveTimer()) === next) return;
        const rumor = buildDmRumor({
          kind: KIND_DM_TIMER,
          content: "",
          tags: dmTimerTags(peers, next),
          pubkey: self,
        });
        await writeDm17Rumors(self, [openedOf(rumor)]);
        await queryClient.invalidateQueries({ queryKey: timerQueryKey });
        await publishRumor(rumor).catch(() => {});
      })();
    },
    [canSend, self, peers, resolveTimer, openedOf, publishRumor, queryClient, timerQueryKey],
  );

  /**
   * Delete an own rumor: write the kind-5 locally at once (the store's NIP-09
   * pass removes the target), publish the wrapped delete in the background.
   */
  const sendDelete = useCallback(
    (targetId: string, targetKind: number) => {
      if (!canSend || !self || peers.length === 0) return;
      const rumor = buildDmRumor({
        kind: KIND_DM_DELETE,
        content: "",
        tags: dmDeleteTags(peers, targetId, targetKind),
        pubkey: self,
      });
      // Drop an optimistic target immediately (it may not be in the store yet).
      setPending((old) => {
        if (!old.has(targetId)) return old;
        const next = new Map(old);
        next.delete(targetId);
        return next;
      });
      void writeDm17Rumors(self, [openedOf(rumor)]);
      void publishRumor(rumor).catch(() => {});
    },
    [canSend, self, peers, openedOf, publishRumor],
  );

  const removeReaction = useCallback(
    (reactionRumorId: string) => sendDelete(reactionRumorId, KIND_DM_REACTION),
    [sendDelete],
  );

  const sendStatusFor = useCallback((id: string) => pending.get(id)?.status, [pending]);

  const retry = useCallback(
    (id: string) => {
      const entry = pending.get(id);
      if (!entry || entry.status !== "failed") return;
      if (entry.batch) {
        dispatchBatch(entry.batch, id);
        return;
      }
      const o = entry.opened;
      const rumor: NostrRumor = {
        id: o.rumorId,
        kind: o.kind,
        content: o.content,
        tags: o.tags,
        created_at: o.createdAt,
        pubkey: o.author,
      };
      dispatchRumor(rumor, o);
    },
    [pending, dispatchBatch, dispatchRumor],
  );

  const discard = dropPending;

  /**
   * Publish one Mini App state update (kind 3310) into this conversation.
   *
   * The session id and the webxdc metadata are the arguments, and the tags are
   * built HERE: a caller passing pre-built tags has to be trusted to have
   * spelled this kind's requirements correctly, and the one that did dropped
   * `info`/`document`/`summary` on the floor — the three fields webxdc's own
   * `sendUpdate` carries.
   */
  const sendWebxdc = useCallback(
    async (uuid: string, payload: string, meta?: DmWebxdcMeta) => {
      if (!canSend || !self || peers.length === 0) {
        throw new Error("This conversation isn't reachable over private DMs yet.");
      }
      const expiresAt = await resolveExpiry();
      const rumor = buildDmRumor({
        kind: KIND_DM_WEBXDC,
        content: payload,
        tags: dmWebxdcTags(peers, uuid, { ...meta, expiresAt }),
        pubkey: self,
      });
      dispatchRumor(rumor, openedOf(rumor), { firstContact: messages.length === 0 });
    },
    [canSend, self, peers, resolveExpiry, dispatchRumor, openedOf, messages.length],
  );

  // ── Older-history backfill ──────────────────────────────────────────────
  // Pages the global `#p` gift-wrap stream with `until`, decrypting each wrap
  // to sort it into its conversation.
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const oldestRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);
  useEffect(() => {
    oldestRef.current = undefined;
    setHasMore(true);
  }, [self, conversation]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!ctx || !self || peers.length === 0 || loadingRef.current || !hasMore) return 0;
    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      const window = threadWindowRef.current;
      const before = queryClient.getQueryData<OpenedDm[]>(queryKey) ?? [];
      // Wraps for a message sent at T are backdated to ≤ T, so `until` at the
      // oldest WINDOW rumor's timestamp reaches everything older. A separately
      // hydrated focus hit must not move this cursor past the unloaded gap.
      const until =
        oldestRef.current ??
        (before.length > 0 ? before[0].createdAt : Math.floor(Date.now() / 1000));
      const { oldest, exhausted, scanned } = await pageOlderDmWraps(ctx, until, true);
      if (oldest !== undefined) oldestRef.current = oldest;
      if (exhausted) setHasMore(false);

      // One wrap yields at most one stored rumor, so a limit of "everything
      // visible plus everything scanned" is guaranteed deep enough to hold
      // this conversation's rows beside every row that was already there.
      // That is a PROBE, not the new floor: the wrap stream is global (see
      // pageOlderDmWraps), so `scanned` counts the whole inbox page and most
      // of it belongs to other correspondents. Persisting it would inflate
      // every later poll by their history, so the floor is clamped to what
      // this conversation actually returned. Capture `window` before
      // the await so a late result from the previous conversation cannot grow
      // the next one's window.
      const probe = Math.max(window.limit, before.length) + scanned;
      const after = await queryDm17Thread(self, peers, { limit: probe });
      window.limit = Math.max(window.limit, after.length);
      const beforeIds = new Set(before.map((row) => row.rumorId));
      const added = after.reduce((count, row) => count + (beforeIds.has(row.rumorId) ? 0 : 1), 0);
      queryClient.setQueryData<OpenedDm[]>(queryKey, after.sort(
        (a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1),
      ));
      return added;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [ctx, self, peers, hasMore, queryClient, queryKey]);

  return {
    messages,
    reactionsByTarget,
    timerChanges,
    timer,
    setTimer,
    // A focused search/permalink row is part of this thread's first usable
    // paint. Waiting for its exact local lookup prevents the generic permalink
    // hunter from starting network backfill before that lookup can answer.
    isLoading: query.isLoading || (Boolean(focusedRumorId) && focusedQuery.isLoading),
    firstPaintReady,
    canSend,
    send,
    sendWebxdc,
    react,
    removeReaction,
    deleteMessage: sendDelete,
    editMessage,
    sendStatusFor,
    retry,
    discard,
    loadOlder,
    hasMore,
    isLoadingOlder,
  };
}

// ── Conversations ─────────────────────────────────────────────────────────────

export interface Dm17Backfill {
  /**
   * Page one screenful of older wraps. Resolves the conversation keys that were
   * NOT in the conversation list before the page — deliberately the raw list
   * rather than a count, because a page recovers history for every
   * correspondent at once and only the caller knows which tier (or mute state)
   * each one lands in. A caller reporting "found N" must narrow this to the
   * list it's showing.
   */
  loadOlder: () => Promise<string[]>;
  /** False once a page comes back empty or short THIS session. */
  hasMore: boolean;
  isLoading: boolean;
}

/**
 * Conversation-level older-history backfill: the same global `#p` paging the
 * thread uses, but driven from the conversation list so senders with no open
 * thread can be recovered at all.
 *
 * This exists because the automatic sync only ever moves FORWARD.
 * `runInboxSync` fetches the newest `INBOX_PAGE` wraps once and thereafter
 * tops up with a `since`-scoped query, so anything older than that first page
 * is never fetched by any automatic path — and a correspondent whose only
 * messages predate it is invisible rather than merely un-listed.
 *
 * Deliberately NOT wired to scroll: each page costs two NIP-44 opens per wrap
 * (and on a prompting signer, the consent gate), so it stays an explicit
 * user-initiated action rather than something a stray flick can trigger.
 *
 * The persisted cursor's `exhausted` flag is NOT consulted. It's inferred from
 * a short page, which is indistinguishable from a relay silently capping our
 * `limit` — honoring it would let one capped response permanently disable a
 * button the user is deliberately pressing. One wasted round-trip against a
 * genuinely empty inbox is the cheaper mistake.
 */
export function useDm17Backfill(): Dm17Backfill {
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const ctx = useDm17SyncCtx();
  const self = user?.pubkey;
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const oldestRef = useRef<number | undefined>(undefined);
  const loadingRef = useRef(false);

  useEffect(() => {
    oldestRef.current = undefined;
    setHasMore(true);
  }, [self]);

  const loadOlder = useCallback(async (): Promise<string[]> => {
    if (!ctx || !self || loadingRef.current) return [];
    loadingRef.current = true;
    setIsLoading(true);
    try {
      // Resume from the persisted floor on the first press of the session, so
      // pressing it again after a reload doesn't re-walk history already paged.
      const cursor = oldestRef.current === undefined ? await readDm17Cursor(self) : undefined;
      const until =
        oldestRef.current ??
        (cursor?.oldest ? cursor.oldest - 1 : Math.floor(Date.now() / 1000));
      const before = await queryDm17Conversations(self);
      const known = new Set(before.map((c) => c.key));
      const { oldest, exhausted } = await pageOlderDmWraps(ctx, until, true);
      if (oldest !== undefined) oldestRef.current = oldest;
      if (exhausted) setHasMore(false);
      const after = await queryDm17Conversations(self);
      // Unconditional: a page can add messages to conversations that already
      // exist without changing how many there are.
      void queryClient.invalidateQueries({ queryKey: ["dm17", "conversations"] });
      return after.map((c) => c.key).filter((key) => !known.has(key));
    } catch {
      return [];
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [ctx, self, queryClient]);

  return { loadOlder, hasMore, isLoading };
}

export type Dm17Conversation = Dm17ConversationRow;

/**
 * The viewer's NIP-17 conversations: every conversation with the
 * newest decrypted message, muted peers excluded. Local-first from the rumor
 * store; the shared inbox sync tops up in the background (prompt-gated —
 * pass `interactive` from user-facing surfaces so the one-time consent prompt
 * can open; the always-mounted unread dot leaves it off and never prompts).
 * Merge with the kind-4 list at the consumer (see DMsPage / useHasUnreadDMs).
 */
export function useDm17Conversations(opts?: { interactive?: boolean }): {
  conversations: Dm17Conversation[];
  isLoading: boolean;
} {
  const interactive = opts?.interactive ?? false;
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const ctx = useDm17SyncCtx();
  const support = useDm17Support();
  const { consent } = useDecryptConsent();
  const { mutedPubkeys, ready: muteReady } = useMutedPubkeys();
  const self = user?.pubkey;

  const queryKey = useMemo(
    () => ["dm17", "conversations", self, consent, interactive] as const,
    [self, consent, interactive],
  );

  const query = useQuery<Dm17Conversation[]>({
    queryKey,
    enabled: !!self && support,
    queryFn: async ({ signal }) => {
      const rows = await queryDm17Conversations(self!, { signal });
      if (!ctx) return rows;

      // On the FIRST sync this device's rumor store is empty, so `rows` is not
      // "no conversations" — it's "not synced yet". Await the inbox pass and
      // re-read, rather than resolving to an empty list the pass then fills in
      // underneath the user. Every later load renders store-first and lets the
      // pass correct it in the background.
      if (isDmSynced("nip17", self)) {
        void syncDm17Inbox(ctx, { interactive });
        return rows;
      }
      if (await syncDm17Inbox(ctx, { interactive })) markDmSynced("nip17", self);
      return await queryDm17Conversations(self!, { signal });
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  useWireScopes((scopes) => {
    if (!self) return;
    if (ctx && scopes.has("dm:wrap")) {
      // An INTERACTIVE conversations surface (the DMs page) always drains —
      // it may open the one-time consent prompt. The always-mounted
      // non-interactive unread dot drains only when decryption can proceed
      // SILENTLY (nsec login, or consent already granted): openAndStore never
      // defers then, so the dot lights live even with no DM surface open
      // instead of waiting on the 60s poll. When a prompt would be needed it
      // stays hands-off (never prompts from the rail) — and even a raced
      // consent flip is loss-proof now: a deferred pass re-buffers, and
      // concurrent surfaces coalesce onto one pass (see openLiveDm17Wraps).
      const silent = !signerNeedsApproval(ctx.method) || getDecryptConsent() === "allowed";
      if (interactive || silent) void openLiveDm17Wraps(ctx, { interactive });
    }
    if (scopes.has("dm") || scopes.has("dm:wrap")) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  // A conversation is hidden when ANY participant is muted, not only when all
  // of them are. Mute means "I don't want to see this person's messages", and a
  // group has no per-sender filter to honour that with — the muted member's
  // messages are addressed to the whole room and would render like anyone
  // else's. Losing the rest of the group with them is the cost; it reduces to
  // exactly the previous behaviour for a 1:1, and unmuting brings it back.
  const conversations = useMemo(() => {
    if (!muteReady) return [];
    return (query.data ?? []).filter((c) => !c.peers.some((peer) => mutedPubkeys.has(peer)));
  }, [query.data, mutedPubkeys, muteReady]);

  return { conversations, isLoading: query.isLoading || !muteReady };
}

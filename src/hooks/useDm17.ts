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
 *     since-scoped with a 2-day slack window (NIP-59 backdating).
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { useDmRelayList, useDmRelaysFor } from "@/hooks/useDmRelayList";
import { useEventStore } from "@/hooks/useEventStore";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { APP_RELAYS } from "@/lib/platform";
import { mayBulkDecrypt, signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { getDecryptConsent } from "@/lib/decryptConsent";
import { isDmSynced, markDmSynced } from "@/lib/dmSynced";
import { markOwnWebPushEvent } from "@/lib/webPushState";
import {
  buildDmRumor,
  DM_RUMOR_KINDS,
  dmChatTags,
  dmDeleteTags,
  dmReactionTags,
  dmTimerTags,
  expirationOf,
  isExpired,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_FILE,
  KIND_DM_REACTION,
  KIND_DM_TIMER,
  MAX_WRAP_BACKDATE_SECS,
  openDmWrap,
  sealDmRumor,
  wrapDmSeal,
  type Dm17Signer,
  type DmRumor,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import {
  DM17_SEEN_CAP,
  drainLiveDmWraps,
  hasBufferedLiveDmWraps,
  queryDm17Conversations,
  queryDm17Thread,
  queryDm17Timer,
  readDm17Cursor,
  readDm17SeenWrapIds,
  rebufferLiveDmWraps,
  sweepExpiredDm17Rumors,
  updateDm17Cursor,
  writeDm17Rumors,
  writeDm17SeenWrapIds,
} from "@/lib/nip17/dm17Store";
import { useWireScopes } from "@/wire/useWireScopes";
import { dm17NotifyCandidates, feedNotifyCandidates } from "@/wire/notify";

import type { SendStatus } from "@/hooks/useGroupMessages";
import type { NostrEvent, NostrFilter, NostrSigner } from "@nostrify/nostrify";

/** Minimum interval between inbox relay scans (wire-bus invalidations stay local). */
const SYNC_MIN_INTERVAL_MS = 30_000;
/** Wraps are backdated ≤ 2 days; re-scan this far behind the cursor. */
const RESYNC_SLACK_SECS = MAX_WRAP_BACKDATE_SECS + 3600;
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
function sweepExpiredSoon(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  void sweepExpiredDm17Rumors().catch(() => undefined);
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

/** Per-viewer sync throttling + seen wrap ids (skip re-decrypt churn). */
const lastSyncAt = new Map<string, number>();
const lastSyncDeclined = new Map<string, boolean>();
/** In-flight inbox passes per viewer, so concurrent callers await the same one. */
const inflightSync = new Map<string, Promise<boolean>>();
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
        // Foreign rumor kinds (e.g. Concord direct invites, kind 3313) are not
        // ours to store — their own scan paths handle them.
        if (dm && DM_RUMOR_KINDS.includes(dm.kind)) opened.push(dm);
      }),
    );
    if (i + DECRYPT_WAVE < wraps.length) await new Promise((r) => setTimeout(r, 0));
  }
  await writeDm17Rumors(opened);
  feedNotifyCandidates(dm17NotifyCandidates(opened, ctx.self));
  persistSeenWraps(ctx.self);
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
  const newest = Math.max(...wraps.map((w) => w.created_at));
  await updateDm17Cursor(ctx.self, { newest });
  return "consumed";
}

/**
 * Top up the viewer's gift-wrap inbox from their DM relays. Throttled per
 * viewer; a consent decline leaves the cursor unadvanced so the wraps are
 * retried once consent flips.
 */
export async function syncDm17Inbox(ctx: SyncCtx, opts?: { force?: boolean; interactive?: boolean }): Promise<boolean> {
  if (!ctx.self || !ctx.signer.nip44 || ctx.relays.length === 0) return false;
  // Concurrent callers coalesce onto ONE pass. The unread dot and the DMs page
  // each mount their own conversations query, so both call this on a cold
  // start; without this the loser returns immediately on the throttle below
  // while the winner is still fetching, and a first sync waiting on it would
  // resolve against a store the pass hasn't filled yet.
  const inflight = inflightSync.get(ctx.self);
  if (inflight) return inflight;
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
  inflightSync.set(ctx.self, pass);
  try {
    return await pass;
  } finally {
    inflightSync.delete(ctx.self);
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
async function queryWrapsPerRelay(
  ctx: SyncCtx,
  filter: NostrFilter,
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const byId = new Map<string, NostrEvent>();
  await Promise.all(
    ctx.relays.map(async (url) => {
      try {
        const evs = await ctx.nostr.relay(url).query([filter], { signal });
        for (const e of evs) byId.set(e.id, e);
      } catch {
        // Best-effort per relay: one dead or slow relay never sinks the pass.
      }
    }),
  );
  return [...byId.values()];
}

/**
 * One inbox pass. Resolves true only when the relay query completed and its
 * wraps were consumed — a throw, or a consent deferral, resolves false so
 * callers never mistake a failed pass for "synced".
 */
async function runInboxSync(
  ctx: SyncCtx,
  opts: { force?: boolean; interactive?: boolean } | undefined,
  now: number,
): Promise<boolean> {
  try {
    const [cursor] = await Promise.all([readDm17Cursor(ctx.self), loadSeenWraps(ctx.self)]);
    const since = cursor?.newest ? Math.max(0, cursor.newest - RESYNC_SLACK_SECS) : undefined;
    const filter: { kinds: number[]; "#p": string[]; limit: number; since?: number } = {
      kinds: [1059],
      "#p": [ctx.self],
      limit: INBOX_PAGE,
    };
    if (since !== undefined) filter.since = since;

    const wraps = await queryWrapsPerRelay(ctx, filter, AbortSignal.timeout(8000));
    const seen = seenSetFor(ctx.self);
    const fresh = wraps.filter((w) => !seen.has(w.id));

    if (!(await openAndStore(ctx, fresh, opts?.interactive ?? false))) return false; // deferred: retry later

    if (wraps.length > 0) {
      const newest = Math.max(...wraps.map((w) => w.created_at));
      const oldest = Math.min(...wraps.map((w) => w.created_at));
      await updateDm17Cursor(ctx.self, {
        newest,
        // First full scan seeds the backfill floor; a short page means the
        // relays had nothing deeper.
        ...(cursor ? {} : { oldest, exhausted: wraps.length < INBOX_PAGE }),
      });
    } else if (!cursor) {
      await updateDm17Cursor(ctx.self, { newest: Math.floor(now / 1000), oldest: Math.floor(now / 1000), exhausted: true });
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
): Promise<{ oldest?: number; exhausted: boolean }> {
  const wraps = await queryWrapsPerRelay(
    ctx,
    { kinds: [1059], "#p": [ctx.self], until, limit: INBOX_PAGE },
    AbortSignal.timeout(8000),
  );
  if (wraps.length === 0) return { exhausted: true };
  const oldest = Math.min(...wraps.map((w) => w.created_at)) - 1;
  await loadSeenWraps(ctx.self);
  const seen = seenSetFor(ctx.self);
  await openAndStore(
    ctx,
    wraps.filter((w) => !seen.has(w.id)),
    interactive,
  );
  await updateDm17Cursor(ctx.self, { oldest });
  return { oldest, exhausted: wraps.length < INBOX_PAGE };
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
  const relays = useMemo(
    () => [...new Set([...effectiveDmRelays(config), ...publishedRelays])],
    [config, publishedRelays],
  );
  const relayKey = relays.join(",");
  return useMemo(() => {
    if (!user?.pubkey || !user.signer.nip44) return undefined;
    return { nostr, signer: user.signer, self: user.pubkey, method: user.method, relays };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user, relayKey]);
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
   * Whether NIP-17 sends to this peer are possible: the signer does NIP-44
   * and we have somewhere to publish the gift wrap — the peer's published
   * kind-10050 inbox, or (when they have none) our own app/DM relays as a
   * best-effort fallback. When false, callers use the kind-4 path.
   */
  canSend: boolean;
  /**
   * Whether the peer has PUBLISHED a kind-10050 inbox (guaranteed-reachable
   * private delivery). When false but `canSend` is true, we're delivering the
   * private DM to shared relays best-effort — reachable if the peer reads them.
   */
  hasPeerInbox: boolean;
  /** Send a chat message (kind 14). Resolves once optimistically rendered. */
  send: (content: string, extraTags?: string[][]) => Promise<void>;
  /** Send a kind-7 reaction targeting a message in this conversation. */
  react: (targetId: string, targetKind: number, content: string, emojiUrl?: string) => void;
  /** Retract an own reaction (kind-5 delete of the reaction rumor). */
  removeReaction: (reactionRumorId: string) => void;
  /** Delete an own message (kind-5 delete rumor into the conversation). */
  deleteMessage: (targetId: string, targetKind: number) => void;
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

/** The decrypted NIP-17 thread with one peer, plus send/react/delete. */
export function useDm17Thread(peer: string | undefined): Dm17Thread {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const ctx = useDm17SyncCtx();
  const { consent } = useDecryptConsent();
  const support = useDm17Support();
  const eventStore = useEventStore();
  const peerInboxRelays = useDmRelaysFor(peer);
  // Where OUR copies live and where our other sessions read: the same union the
  // inbox sync uses (effective DM relays ∪ our published kind-10050 inbox).
  const myRelays = ctx?.relays ?? effectiveDmRelays(config);

  const self = user?.pubkey;
  // NIP-17 send is possible when the signer does NIP-44 and we have SOMEWHERE
  // to publish the gift wrap. The spec's canonical target is the peer's
  // published kind-10050 inbox; when they have none we fall back to our own
  // (app / DM) relays — fully private (still gift-wrapped, no metadata leak),
  // and reachable whenever the peer reads those shared relays (the common
  // Armada case). `hasPeerInbox` lets the UI flag best-effort delivery.
  const hasPeerInbox = peerInboxRelays.length > 0;
  const canSend = support && !!peer && (hasPeerInbox || myRelays.length > 0);

  // Optimistic outgoing rumors (pending/failed), keyed by rumor id. Confirmed
  // sends land in the store and drop out of here.
  const [pending, setPending] = useState<Map<string, PendingRumor>>(new Map());
  useEffect(() => setPending(new Map()), [self, peer]);

  const queryKey = useMemo(() => ["dm17", "thread", self, peer, consent] as const, [self, peer, consent]);

  const query = useQuery<OpenedDm[]>({
    queryKey,
    enabled: !!self && !!peer && support,
    queryFn: async ({ signal }) => {
      // LOCAL-FIRST: the store paints immediately; the inbox scan tops up in
      // the background (throttled) and rings the `dm` scope on new rumors.
      const rows = await queryDm17Thread(peer!, { limit: THREAD_WINDOW, signal });
      if (ctx) void syncDm17Inbox(ctx, { interactive: true });
      sweepExpiredSoon();
      return rows.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    },
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // The live disappearing-messages timer, read on its own so a setting made
  // beyond the thread window is still in force (see queryDm17Timer). Shares
  // the thread's invalidation: a timer rumor lands through the same `dm` ring.
  const timerQueryKey = useMemo(() => ["dm17", "timer", self, peer] as const, [self, peer]);
  const timerQuery = useQuery<number>({
    queryKey: timerQueryKey,
    enabled: !!self && !!peer && support,
    queryFn: async ({ signal }) => (await queryDm17Timer(peer!, { signal })) ?? 0,
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
  //   - `dm` — the store changed (our decrypt/sends/deletes wrote rumors).
  //     Re-read only; never decrypt-again (that would loop on its own `dm` ring).
  useWireScopes((scopes) => {
    if (!self || !peer || !ctx) {
      if (scopes.has("dm") || scopes.has("dm:wrap")) {
        void queryClient.invalidateQueries({ queryKey });
        void queryClient.invalidateQueries({ queryKey: timerQueryKey });
      }
      return;
    }
    if (scopes.has("dm:wrap")) {
      void openLiveDm17Wraps(ctx, { interactive: true }).then((result) => {
        if (result === "empty") void syncDm17Inbox(ctx, { force: true, interactive: true });
      });
    }
    if (scopes.has("dm") || scopes.has("dm:wrap")) {
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
  }, [query.data, pending, expiryTick]);

  // Re-fold exactly when the next message expires (and sweep it off disk).
  // setTimeout is clamped to ~24.8 days by the 32-bit delay; a longer deadline
  // just re-arms on the next fold, which the poll/refetch guarantees.
  useEffect(() => {
    if (nextExpiry === undefined) return;
    const delay = Math.min(nextExpiry * 1000 - Date.now(), 2 ** 31 - 1);
    const id = setTimeout(() => {
      sweepExpiredSoon();
      setExpiryTick((t) => t + 1);
    }, Math.max(0, delay));
    return () => clearTimeout(id);
  }, [nextExpiry]);

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
      if (!old.has(id)) return old;
      const next = new Map(old);
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

  /**
   * Seal + wrap + publish one rumor: the peer's copy to their kind-10050
   * inbox relays (NIP-17 publishing rule), the self copy to the viewer's own
   * DM relays. Resolves when the PEER copy is accepted; the self copy is
   * best-effort (the rumor is already in the local store).
   */
  const publishRumor = useCallback(
    async (rumor: DmRumor, opts?: { firstContact?: boolean }) => {
      if (!user?.signer.nip44 || !self || !peer) throw new Error("NIP-17 not available");
      const signer = user.signer as unknown as Dm17Signer;

      // Sequential seals: NIP-07 extensions reject concurrent signEvent calls.
      const sealPeer = await sealDmRumor(rumor, peer, signer);
      const sealSelf = peer === self ? undefined : await sealDmRumor(rumor, self, signer);

      // The rumor's own NIP-40 deadline rides all the way out: sealDmRumor
      // copies it onto the seal, and the wrap repeats it in the clear so
      // NIP-40-aware relays drop their stored copy too.
      const expiresAt = expirationOf(rumor.tags);
      const wrapPeer = wrapDmSeal(sealPeer, peer, { firstContact: opts?.firstContact, expiresAt });
      const wrapSelf = sealSelf ? wrapDmSeal(sealSelf, self, { expiresAt }) : undefined;

      // Persist OUR self-addressed wrap locally BEFORE publishing. On Android
      // the event store is the same database the notification service dedupes
      // its kind-1059 inbox against, so when this wrap echoes back off the
      // relay it's recognized as already seen instead of firing a spurious
      // "New direct message".
      const selfCopy = wrapSelf ?? wrapPeer; // peer === self ⇒ the peer copy IS the self copy
      // Mark before either relay publish. The content-blind push server cannot
      // distinguish an incoming wrap from our NIP-17 self-copy, but the service
      // worker can suppress this exact event id without seeing plaintext.
      await markOwnWebPushEvent(selfCopy.id);
      await eventStore.then((s) => s.event(selfCopy)).catch(() => undefined);

      // The self copy is fire-and-forget: it exists for OTHER devices/sessions,
      // and this device already has the rumor locally.
      if (wrapSelf && myRelays.length > 0) {
        void nostr.group(myRelays).event(wrapSelf, { signal: AbortSignal.timeout(8000) }).catch(() => {});
      }
      // Deliver the peer copy to their published inbox (NIP-17's rule) UNIONED
      // with our own DM relays. The peer's 10050 relays are where a compliant
      // client reads, but writing there ALSO requires us to reach them; adding
      // our own relays hedges against a peer inbox we can't publish to (auth,
      // downtime) and lets our other sessions/the recipient's fallback readers
      // find the wrap. Deduped so shared relays aren't double-published.
      const peerTargets = [...new Set([...peerInboxRelays, ...myRelays])];
      await nostr.group(peerTargets).event(wrapPeer, { signal: AbortSignal.timeout(8000) });
    },
    [nostr, user, self, peer, peerInboxRelays, myRelays, eventStore],
  );

  /** Optimistically render a rumor, then seal/wrap/publish in the background. */
  const dispatchRumor = useCallback(
    (rumor: DmRumor, opened: OpenedDm, opts?: { firstContact?: boolean }) => {
      setPending((old) => new Map(old).set(rumor.id, { opened, status: "pending" }));
      void (async () => {
        try {
          await publishRumor(rumor, opts);
          // Durable + confirmed: persist and clear the send badge, but KEEP the
          // optimistic row. It is retired only once the query has actually read
          // it back (see the prune effect) — the store write's `dm` ring is
          // debounced and the repaint costs an IndexedDB read, so dropping it
          // here would blank the row for that whole window.
          await writeDm17Rumors([opened]);
          setStatus(rumor.id, undefined);
        } catch {
          setStatus(rumor.id, "failed");
        }
      })();
    },
    [publishRumor, setStatus],
  );

  const openedOf = useCallback(
    (rumor: DmRumor): OpenedDm => ({
      rumorId: rumor.id,
      author: rumor.pubkey,
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      createdAt: rumor.created_at,
      peer: peer!,
      wrapId: "",
    }),
    [peer],
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
    if (!peer) return 0;
    return (await queryDm17Timer(peer).catch(() => undefined)) ?? 0;
  }, [peer]);

  /** The NIP-40 deadline for something sent right now, or undefined when off. */
  const resolveExpiry = useCallback(async (): Promise<number | undefined> => {
    const seconds = await resolveTimer();
    return seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : undefined;
  }, [resolveTimer]);

  const send = useCallback(
    async (content: string, extraTags?: string[][]) => {
      if (!canSend || !self || !peer) throw new Error("This person isn't reachable over private DMs yet.");
      const trimmed = content.trim();
      if (!trimmed) return;
      const expiresAt = await resolveExpiry();
      const rumor = buildDmRumor({
        kind: KIND_DM_CHAT,
        content: trimmed,
        tags: dmChatTags(peer, { extraTags, expiresAt }),
        pubkey: self,
      });
      // First contact = nothing in this thread yet: add the outer `k` hint so
      // a k-aware receiver can index their cold inbox.
      dispatchRumor(rumor, openedOf(rumor), { firstContact: messages.length === 0 });
    },
    [canSend, self, peer, dispatchRumor, openedOf, messages.length, resolveExpiry],
  );

  const react = useCallback(
    (targetId: string, targetKind: number, content: string, emojiUrl?: string) => {
      if (!canSend || !self || !peer) return;
      // Deferred by a microtask (or one store read on a cold open) so the
      // reaction inherits the same deadline a message sent now would get.
      void (async () => {
        const expiresAt = await resolveExpiry();
        const rumor = buildDmRumor({
          kind: KIND_DM_REACTION,
          content,
          tags: dmReactionTags(
            peer,
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
    [canSend, self, peer, dispatchRumor, openedOf, resolveExpiry],
  );

  /**
   * Change the conversation's disappearing-messages timer. Written locally
   * first (so the notice row and the new timer apply immediately) and
   * published wrapped to the peer, exactly like a delete. Timer rumors carry
   * no expiration of their own — see KIND_DM_TIMER.
   */
  const setTimer = useCallback(
    (seconds: number) => {
      if (!canSend || !self || !peer) return;
      const next = Math.max(0, Math.floor(seconds));
      void (async () => {
        // Compare against the RESOLVED timer, not a possibly-unloaded one:
        // otherwise picking "Off" on a cold thread would silently no-op and
        // leave the conversation disappearing.
        if ((await resolveTimer()) === next) return;
        const rumor = buildDmRumor({
          kind: KIND_DM_TIMER,
          content: "",
          tags: dmTimerTags(peer, next),
          pubkey: self,
        });
        await writeDm17Rumors([openedOf(rumor)]);
        await queryClient.invalidateQueries({ queryKey: timerQueryKey });
        await publishRumor(rumor).catch(() => {});
      })();
    },
    [canSend, self, peer, resolveTimer, openedOf, publishRumor, queryClient, timerQueryKey],
  );

  /**
   * Delete an own rumor: write the kind-5 locally at once (the store's NIP-09
   * pass removes the target), publish the wrapped delete in the background.
   */
  const sendDelete = useCallback(
    (targetId: string, targetKind: number) => {
      if (!canSend || !self || !peer) return;
      const rumor = buildDmRumor({
        kind: KIND_DM_DELETE,
        content: "",
        tags: dmDeleteTags(peer, targetId, targetKind),
        pubkey: self,
      });
      // Drop an optimistic target immediately (it may not be in the store yet).
      setPending((old) => {
        if (!old.has(targetId)) return old;
        const next = new Map(old);
        next.delete(targetId);
        return next;
      });
      void writeDm17Rumors([openedOf(rumor)]);
      void publishRumor(rumor).catch(() => {});
    },
    [canSend, self, peer, openedOf, publishRumor],
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
      const o = entry.opened;
      const rumor: DmRumor = {
        id: o.rumorId,
        kind: o.kind,
        content: o.content,
        tags: o.tags,
        created_at: o.createdAt,
        pubkey: o.author,
      };
      dispatchRumor(rumor, o);
    },
    [pending, dispatchRumor],
  );

  const discard = dropPending;

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
  }, [self, peer]);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (!ctx || !self || !peer || loadingRef.current || !hasMore) return 0;
    loadingRef.current = true;
    setIsLoadingOlder(true);
    try {
      // Wraps for a message sent at T are backdated to ≤ T, so `until` at the
      // oldest rendered rumor's timestamp reaches everything older.
      const until =
        oldestRef.current ??
        (messages.length > 0 ? messages[0].createdAt : Math.floor(Date.now() / 1000));
      const before = await queryDm17Thread(peer, { limit: THREAD_WINDOW * 2 });
      const { oldest, exhausted } = await pageOlderDmWraps(ctx, until, true);
      if (oldest !== undefined) oldestRef.current = oldest;
      if (exhausted) setHasMore(false);
      const after = await queryDm17Thread(peer, { limit: THREAD_WINDOW * 2 });
      const added = Math.max(0, after.length - before.length);
      if (added > 0) void queryClient.invalidateQueries({ queryKey });
      return added;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [ctx, self, peer, hasMore, messages, queryClient, queryKey]);

  return {
    messages,
    reactionsByTarget,
    timerChanges,
    timer,
    setTimer,
    isLoading: query.isLoading,
    canSend,
    hasPeerInbox,
    send,
    react,
    removeReaction,
    deleteMessage: sendDelete,
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
   * Page one screenful of older wraps. Resolves the peers that were NOT in the
   * conversation list before the page — deliberately the raw peer list rather
   * than a count, because a page recovers history for every correspondent at
   * once and only the caller knows which tier (or mute state) each one lands
   * in. A caller reporting "found N" must narrow this to the list it's showing.
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
      const before = await queryDm17Conversations({ self });
      const known = new Set(before.map((c) => c.peer));
      const { oldest, exhausted } = await pageOlderDmWraps(ctx, until, true);
      if (oldest !== undefined) oldestRef.current = oldest;
      if (exhausted) setHasMore(false);
      const after = await queryDm17Conversations({ self });
      // Unconditional: a page can add messages to conversations that already
      // exist without changing how many there are.
      void queryClient.invalidateQueries({ queryKey: ["dm17", "conversations"] });
      return after.map((c) => c.peer).filter((peer) => !known.has(peer));
    } catch {
      return [];
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [ctx, self, queryClient]);

  return { loadOlder, hasMore, isLoading };
}

export interface Dm17Conversation {
  peer: string;
  latest: OpenedDm;
  /** The viewer has authored at least one message in this conversation. */
  mine: boolean;
}

/**
 * The viewer's NIP-17 conversations: every conversation partner with the
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
      const rows = await queryDm17Conversations({ self, signal });
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
      return await queryDm17Conversations({ self, signal });
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

  const conversations = useMemo(() => {
    if (!muteReady) return [];
    return (query.data ?? []).filter((c) => !mutedPubkeys.has(c.peer));
  }, [query.data, mutedPubkeys, muteReady]);

  return { conversations, isLoading: query.isLoading || !muteReady };
}

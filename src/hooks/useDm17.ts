/**
 * NIP-17 direct messages — sync, thread, and conversation hooks.
 *
 * The modern DM plane beside the legacy kind-4 engine (`useDirectMessages`).
 * Wire format lives in `src/lib/nip17/protocol.ts` (classic NIP-17 envelope +
 * the nips#2396 deterministic conversation wrap key); decrypted rumors persist
 * in `src/lib/nip17/dm17Store.ts`. These hooks own the relay traffic:
 *
 *   - INBOX SYNC: a throttled `{kinds:[1059], "#p":[me]}` top-up against the
 *     viewer's DM relays. Every new wrap is opened once (consent-gated for
 *     prompting signers — two nip44 decrypts per wrap) and the rumor is
 *     stored decrypted; the ciphertext is never persisted. The scan is
 *     since-scoped with a 2-day slack window (NIP-59 backdating).
 *   - THREAD: local-first store read + the shared inbox sync; per-thread
 *     older-history backfill pages the global `#p` stream AND (when the raw
 *     key is available) the conversation's deterministic wrap address —
 *     `{authors:[convPk]}` — which reaches one conversation's history without
 *     pulling the whole inbox (the nips#2396 payoff).
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
import { useNostrLogin } from "@nostrify/react/login";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDecryptConsent } from "@/hooks/useDecryptConsent";
import { useDmRelayList, useDmRelaysFor } from "@/hooks/useDmRelayList";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { customEmojiReactionTags } from "@/hooks/useReactions";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { APP_RELAYS } from "@/lib/platform";
import { mayBulkDecrypt, signerNeedsApproval } from "@/lib/bulkDecryptGate";
import { getDecryptConsent } from "@/lib/decryptConsent";
import {
  buildDmRumor,
  conversationWrapKey,
  DM_RUMOR_KINDS,
  dmChatTags,
  dmDeleteTags,
  dmReactionTags,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_FILE,
  KIND_DM_REACTION,
  MAX_WRAP_BACKDATE_SECS,
  openDmWrap,
  sealDmRumor,
  wrapDmSeal,
  type Dm17Signer,
  type DmRumor,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import {
  queryDm17Conversations,
  queryDm17Thread,
  readDm17Cursor,
  updateDm17Cursor,
  writeDm17Rumors,
} from "@/lib/nip17/dm17Store";
import { useWireScopes } from "@/wire/useWireScopes";

import type { SendStatus } from "@/hooks/useGroupMessages";
import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

/** Minimum interval between inbox relay scans (wire-bus invalidations stay local). */
const SYNC_MIN_INTERVAL_MS = 30_000;
/** Wraps are backdated ≤ 2 days; re-scan this far behind the cursor. */
const RESYNC_SLACK_SECS = MAX_WRAP_BACKDATE_SECS + 3600;
/** Newest wraps fetched per inbox scan / backfill page. */
const INBOX_PAGE = 500;
/** Rumors read per thread window. */
const THREAD_WINDOW = 300;

/** Whether the current signer can do NIP-17 (NIP-44 encrypt/decrypt). */
export function useDm17Support(): boolean {
  const { user } = useCurrentUser();
  return !!user?.signer.nip44;
}

/** One inbox-announce attempt per (session, pubkey) — see useEnsureDmInbox. */
const inboxAnnounced = new Set<string>();
/** One DM-relay auto-adopt attempt per (session, pubkey) — see useEnsureDmInbox. */
const dmRelaysAdopted = new Set<string>();

/**
 * Ensure the viewer is REACHABLE over NIP-17 and reads/writes DMs where they
 * declared:
 *
 *   - No published kind-10050 list → publish one (their effective DM relays).
 *     NIP-17 senders MUST only deliver to a recipient's 10050 relays; no list
 *     means "not ready to receive" and compliant clients won't even try.
 *   - HAS a published list but "use my own DM relays" is off and they've never
 *     customized the DM-relay set → adopt the published list and flip the
 *     toggle on. The user's declared inbox is the canonical place their DMs
 *     live, so it should be the default read/write set — otherwise DMs land on
 *     their 10050 relays but we read from the app relays. A deliberate later
 *     toggle-off / custom list is preserved (we only auto-adopt the untouched
 *     default, once per session).
 *
 * Called from the DMs page (an interactive surface, so a signer prompt is in
 * context); once per session, best-effort, and never overwrites an existing
 * list.
 */
export function useEnsureDmInbox(): void {
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const support = useDm17Support();
  const { hasList, isLoading, relays: publishedRelays, publish } = useDmRelayList();
  const relays = effectiveDmRelays(config);
  const relayKey = relays.join(",");
  const publishedKey = publishedRelays.join(",");

  useEffect(() => {
    const self = user?.pubkey;
    if (!self || !support || isLoading || hasList || relays.length === 0) return;
    if (inboxAnnounced.has(self)) return;
    inboxAnnounced.add(self);
    void publish(relays).catch(() => {
      // Declined or offline — retry next session; senders fall back to kind-4.
      inboxAnnounced.delete(self);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, support, isLoading, hasList, relayKey]);

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

/**
 * The viewer's raw secret key when the login holds one locally (nsec logins
 * only) — what the deterministic conversation wrap key needs. Extension and
 * bunker signers never expose it; those sends fall back to ephemeral wrap
 * keys (plain NIP-17), and reads work identically either way.
 */
export function useDm17RawKey(): Uint8Array | undefined {
  const { logins } = useNostrLogin();
  return useMemo(() => {
    const login = logins[0];
    if (!login || login.type !== "nsec") return undefined;
    try {
      const decoded = nip19.decode(login.data.nsec);
      return decoded.type === "nsec" ? (decoded.data as Uint8Array) : undefined;
    } catch {
      return undefined;
    }
  }, [logins]);
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

/** Per-viewer sync throttling + session-seen wrap ids (skip re-decrypt churn). */
const lastSyncAt = new Map<string, number>();
const lastSyncDeclined = new Map<string, boolean>();
const seenWrapIds = new Map<string, Set<string>>();

function seenSetFor(self: string): Set<string> {
  let set = seenWrapIds.get(self);
  if (!set) seenWrapIds.set(self, (set = new Set()));
  return set;
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
  await Promise.all(
    wraps.map(async (wrap) => {
      const dm = await openDmWrap(wrap, ctx.signer as Dm17Signer, ctx.self);
      seen.add(wrap.id);
      // Foreign rumor kinds (e.g. Concord direct invites, kind 3313) are not
      // ours to store — their own scan paths handle them.
      if (dm && DM_RUMOR_KINDS.includes(dm.kind)) opened.push(dm);
    }),
  );
  await writeDm17Rumors(opened);
  return true;
}

/**
 * Top up the viewer's gift-wrap inbox from their DM relays. Throttled per
 * viewer; a consent decline leaves the cursor unadvanced so the wraps are
 * retried once consent flips.
 */
export async function syncDm17Inbox(ctx: SyncCtx, opts?: { force?: boolean; interactive?: boolean }): Promise<void> {
  if (!ctx.self || !ctx.signer.nip44 || ctx.relays.length === 0) return;
  const now = Date.now();
  const last = lastSyncAt.get(ctx.self) ?? 0;
  // A deferred/declined pass left wraps unconsumed: bypass the throttle only
  // once decrypting could actually succeed now — consent flipped to allowed,
  // or an interactive surface (which may open the one-time prompt) is asking.
  const retryDeclined =
    (lastSyncDeclined.get(ctx.self) ?? false) &&
    (opts?.interactive || getDecryptConsent() === "allowed" || !signerNeedsApproval(ctx.method));
  if (!opts?.force && !retryDeclined && now - last < SYNC_MIN_INTERVAL_MS) return;
  lastSyncAt.set(ctx.self, now);

  try {
    const cursor = await readDm17Cursor(ctx.self);
    const since = cursor?.newest ? Math.max(0, cursor.newest - RESYNC_SLACK_SECS) : undefined;
    const filter: { kinds: number[]; "#p": string[]; limit: number; since?: number } = {
      kinds: [1059],
      "#p": [ctx.self],
      limit: INBOX_PAGE,
    };
    if (since !== undefined) filter.since = since;

    const wraps = await ctx.nostr
      .group(ctx.relays)
      .query([filter], { signal: AbortSignal.timeout(8000) });
    const seen = seenSetFor(ctx.self);
    const fresh = wraps.filter((w) => !seen.has(w.id));

    if (!(await openAndStore(ctx, fresh, opts?.interactive ?? false))) return; // deferred: retry later

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
  } catch {
    // Best-effort background sync; local-first reads already rendered.
  }
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
  status: SendStatus;
}

export interface Dm17Thread {
  /** Chat/file rumors, deletes applied, ascending (oldest first). */
  messages: OpenedDm[];
  /** Reaction rumors grouped by their `e` target id (deletes applied). */
  reactionsByTarget: Map<string, OpenedDm[]>;
  isLoading: boolean;
  /**
   * Whether NIP-17 sends to this peer are possible: the signer does NIP-44
   * and the peer has PUBLISHED a kind-10050 DM-relay list (the spec's
   * "ready to receive" signal). When false, callers use the kind-4 path.
   */
  canSend: boolean;
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
  const rawKey = useDm17RawKey();
  const { consent } = useDecryptConsent();
  const support = useDm17Support();
  const peerInboxRelays = useDmRelaysFor(peer);
  // Where OUR copies live and where our other sessions read: the same union the
  // inbox sync uses (effective DM relays ∪ our published kind-10050 inbox).
  const myRelays = ctx?.relays ?? effectiveDmRelays(config);

  const self = user?.pubkey;
  const canSend = support && !!peer && peerInboxRelays.length > 0;

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
      return rows.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    },
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  // The store write path (sync, sends, deletes) announces `dm`; re-read.
  useWireScopes((scopes) => {
    if (self && peer && scopes.has("dm")) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  // Fold: store rows + optimistic rows (deduped by rumor id), deletes applied
  // (belt & suspenders — the store already physically removes self-deletes),
  // split into the message timeline and per-target reactions.
  const { messages, reactionsByTarget } = useMemo(() => {
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
    for (const r of byId.values()) {
      if (deleted.has(r.rumorId)) continue;
      if (r.kind === KIND_DM_CHAT || r.kind === KIND_DM_FILE) {
        messages.push(r);
      } else if (r.kind === KIND_DM_REACTION) {
        const target = r.tags.find(([n, v]) => n === "e" && v)?.[1];
        if (!target) continue;
        const list = reactionsByTarget.get(target) ?? [];
        list.push(r);
        reactionsByTarget.set(target, list);
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || (a.rumorId < b.rumorId ? -1 : 1));
    return { messages, reactionsByTarget };
  }, [query.data, pending]);

  const setStatus = useCallback((id: string, status: SendStatus | undefined) => {
    setPending((old) => {
      const next = new Map(old);
      const entry = next.get(id);
      if (!entry) return old;
      if (status === undefined) next.delete(id);
      else next.set(id, { ...entry, status });
      return next;
    });
  }, []);

  /**
   * Seal + wrap + publish one rumor: the peer's copy to their kind-10050
   * inbox relays (NIP-17 publishing rule), the self copy to the viewer's own
   * DM relays. Signed with the deterministic conversation wrap key when the
   * raw key is available. Resolves when the PEER copy is accepted; the self
   * copy is best-effort (the rumor is already in the local store).
   */
  const publishRumor = useCallback(
    async (rumor: DmRumor, opts?: { firstContact?: boolean }) => {
      if (!user?.signer.nip44 || !self || !peer) throw new Error("NIP-17 not available");
      const signer = user.signer as unknown as Dm17Signer;

      // Sequential seals: NIP-07 extensions reject concurrent signEvent calls.
      const sealPeer = await sealDmRumor(rumor, peer, signer);
      const sealSelf = peer === self ? undefined : await sealDmRumor(rumor, self, signer);

      const wrapSk = rawKey ? conversationWrapKey(rawKey, peer).sk : undefined;
      const wrapPeer = wrapDmSeal(sealPeer, peer, { wrapSk, firstContact: opts?.firstContact });
      const wrapSelf = sealSelf ? wrapDmSeal(sealSelf, self, { wrapSk }) : undefined;

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
    [nostr, user, self, peer, rawKey, peerInboxRelays, myRelays],
  );

  /** Optimistically render a rumor, then seal/wrap/publish in the background. */
  const dispatchRumor = useCallback(
    (rumor: DmRumor, opened: OpenedDm, opts?: { firstContact?: boolean }) => {
      setPending((old) => new Map(old).set(rumor.id, { opened, status: "pending" }));
      void (async () => {
        try {
          await publishRumor(rumor, opts);
          // Durable + confirmed: persist and drop the optimistic row (the
          // store write rings `dm`, so the query repaints with the real row).
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

  const send = useCallback(
    async (content: string, extraTags?: string[][]) => {
      if (!canSend || !self || !peer) throw new Error("This person isn't reachable over private DMs yet.");
      const trimmed = content.trim();
      if (!trimmed) return;
      const rumor = buildDmRumor({
        kind: KIND_DM_CHAT,
        content: trimmed,
        tags: dmChatTags(peer, { extraTags }),
        pubkey: self,
      });
      // First contact = nothing in this thread yet: add the outer `k` hint so
      // a k-aware receiver can index their cold inbox.
      dispatchRumor(rumor, openedOf(rumor), { firstContact: messages.length === 0 });
    },
    [canSend, self, peer, dispatchRumor, openedOf, messages.length],
  );

  const react = useCallback(
    (targetId: string, targetKind: number, content: string, emojiUrl?: string) => {
      if (!canSend || !self || !peer) return;
      const rumor = buildDmRumor({
        kind: KIND_DM_REACTION,
        content,
        tags: dmReactionTags(peer, targetId, targetKind, customEmojiReactionTags(content, emojiUrl)),
        pubkey: self,
      });
      dispatchRumor(rumor, openedOf(rumor));
    },
    [canSend, self, peer, dispatchRumor, openedOf],
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

  const discard = useCallback((id: string) => {
    setPending((old) => {
      if (!old.has(id)) return old;
      const next = new Map(old);
      next.delete(id);
      return next;
    });
  }, []);

  // ── Older-history backfill ──────────────────────────────────────────────
  // Pages the global `#p` wrap stream (covers legacy ephemeral-key senders)
  // and, when the conversation address is derivable, ALSO pages
  // `{authors:[convPk]}` — precise per-conversation reach (nips#2396).
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
      const filters: Array<{ kinds: number[]; "#p": string[]; until: number; limit: number; authors?: string[] }> = [
        { kinds: [1059], "#p": [self], until, limit: INBOX_PAGE },
      ];
      if (rawKey) {
        filters.push({
          kinds: [1059],
          "#p": [self],
          authors: [conversationWrapKey(rawKey, peer).pk],
          until,
          limit: INBOX_PAGE,
        });
      }
      const wraps = await ctx.nostr.group(ctx.relays).query(filters, { signal: AbortSignal.timeout(8000) });
      if (wraps.length === 0) {
        setHasMore(false);
        return 0;
      }
      oldestRef.current = Math.min(...wraps.map((w) => w.created_at)) - 1;
      if (wraps.length < INBOX_PAGE) setHasMore(false);

      const seen = seenSetFor(self);
      const before = await queryDm17Thread(peer, { limit: THREAD_WINDOW * 2 });
      await openAndStore(ctx, wraps.filter((w) => !seen.has(w.id)), true);
      const after = await queryDm17Thread(peer, { limit: THREAD_WINDOW * 2 });
      void updateDm17Cursor(self, { oldest: oldestRef.current });
      const added = Math.max(0, after.length - before.length);
      if (added > 0) void queryClient.invalidateQueries({ queryKey });
      return added;
    } catch {
      return 0;
    } finally {
      loadingRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [ctx, self, peer, hasMore, messages, rawKey, queryClient, queryKey]);

  return {
    messages,
    reactionsByTarget,
    isLoading: query.isLoading,
    canSend,
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

export interface Dm17Conversation {
  peer: string;
  latest: OpenedDm;
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
      const rows = await queryDm17Conversations({ signal });
      if (ctx) void syncDm17Inbox(ctx, { interactive });
      return rows;
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  useWireScopes((scopes) => {
    if (self && scopes.has("dm")) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  const conversations = useMemo(() => {
    if (!muteReady) return [];
    return (query.data ?? []).filter((c) => !mutedPubkeys.has(c.peer));
  }, [query.data, mutedPubkeys, muteReady]);

  return { conversations, isLoading: query.isLoading || !muteReady };
}

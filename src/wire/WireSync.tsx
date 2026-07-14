import { App as CapacitorApp } from "@capacitor/app";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useConcordList } from "@/concord-v1/hooks/useConcordList";
import { buildConcordSubs } from "@/concord-v1/lib/concordNotifications";
import { useCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { controlFoldKey } from "@/concord-v2/hooks/useControlPlane2";
import { openChatBatch } from "@/concord-v2/lib/chat";
import { channelsView } from "@/concord-v2/lib/community";
import { liveEntries, rehydrateCommunity } from "@/concord-v2/lib/communityList";
import { ackPendingWraps, peekPendingWraps, writeRumors } from "@/concord-v2/lib/rumorStore";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useFollowList } from "@/hooks/useFollowList";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { fetchRelayInfoDoc } from "@/hooks/useRelayInfo";
import { readFolded } from "@/lib/foldedCache";
import { buildRelayGroups, KIND_GROUP_METADATA } from "@/lib/nip29";
import { ArmadaNotification } from "@/lib/nativeNotifications";
import { PINNED_RAIL_RELAYS, normalizeRelayUrl } from "@/lib/platform";
import { onRelayReopened } from "@/lib/relayReopen";
import { logSync } from "@/lib/syncLog";
import { emitWireScopes } from "@/wire/bus";
import { ingestWireEvents } from "@/wire/ingest";
import { buildWireSpec, type WireSpec } from "@/wire/spec";

import type { FoldedControl } from "@/concord-v2/lib/control";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Floor for a relay's `since` when we have no cursor yet (fresh device): a
 * short overlap window; deeper history arrives via hydration pulls.
 */
const FRESH_LOOKBACK_SECONDS = 5 * 60;
/**
 * Ceiling for how far back a persisted cursor may reach: a device off for a
 * month resumes at a week, not the epoch. Older history backfills on demand.
 */
const MAX_CURSOR_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Overlap subtracted from a resumed cursor (clock skew / borderline events). */
const CURSOR_OVERLAP_SECONDS = 60;
/**
 * Watchdog on a fresh REQ round: a healthy relay answers with SOMETHING
 * almost immediately (events, or at least EOSE — even an auth-gated relay
 * settles its NIP-42 handshake well inside this). A round that has yielded
 * NOTHING by the deadline is presumed swallowed (a REQ held behind a wedged
 * AUTH exchange, a half-open socket) and is aborted so the loop re-issues it
 * — without this, the `for await` blocks forever and the wire silently dies
 * until an app relaunch (the "I log in and nothing is here" wedge).
 */
const SILENT_REQ_TIMEOUT_MS = 30_000;
/**
 * Rotation ceiling on a QUIET established round: once a round has yielded
 * something, a long silence is usually just a quiet channel — but it is
 * indistinguishable from a subscription that silently died (a relay that
 * dropped its sub state without CLOSED, a re-issued REQ swallowed by the
 * NIP-42 race on a reconnected socket — see relayReopen.ts for the eager
 * path). So a round silent this long is torn down and re-REQ'd from the
 * cursor. Rotation is lossless (the cursor + overlap replays the boundary)
 * and cheap (one REQ frame; an empty replay on a truly quiet relay), and it
 * bounds "live went deaf" to this window instead of "until app relaunch".
 */
const QUIET_ROTATE_MS = 90_000;
/** How often a round's silence is re-checked against the deadlines above. */
const WATCHDOG_TICK_MS = 5_000;

function cursorKey(relay: string): string {
  return `armada:wire-cursor:${relay}`;
}

function readCursor(relay: string): number | undefined {
  try {
    const raw = localStorage.getItem(cursorKey(relay));
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeCursor(relay: string, createdAt: number): void {
  try {
    // Clamp against the local clock: an event stamped in the future (a
    // member's skewed clock, a hostile timestamp) must not drag the cursor
    // past `now` — every later REQ would open with `since > now` and the wire
    // would go deaf on this relay (persistently — the cursor is durable)
    // while everyone else's correctly-stamped messages stop matching.
    const next = Math.min(createdAt, Math.floor(Date.now() / 1000));
    const prev = readCursor(relay) ?? 0;
    if (next > prev) localStorage.setItem(cursorKey(relay), String(next));
  } catch {
    // localStorage unavailable — resume from the fresh lookback next launch.
  }
}

/**
 * Concord V2 channels for EVERY live community in the membership list, with
 * their stream GroupKeys (rehydrated bundle + persisted control-fold snapshot,
 * local reads only). Registers every stream key for NIP-42 stream auth so the
 * wire's kind-1059 REQs pass auth-gating relays. Mirrors useConcord2Subs, but
 * keeps the full ChannelV2 (the wire decrypts; the native service can't).
 */
function useWireConcord2Channels(): Array<{ relays: string[]; channel: ChannelV2 }> {
  const { data } = useCommunityList2();
  const entries = useMemo(() => (data ? liveEntries(data.list) : []), [data]);
  const listSig = useMemo(
    () =>
      entries
        .map((e) => `${e.community_id}:${e.current.root_epoch}:${(e.current.channels ?? []).length}`)
        .sort()
        .join(","),
    [entries],
  );

  const query = useQuery<Array<{ relays: string[]; channel: ChannelV2 }>>({
    queryKey: ["wire", "concord2-channels", listSig],
    enabled: entries.length > 0,
    staleTime: 30_000,
    // Fold snapshots update out-of-band (community open / control sync) —
    // re-read periodically to pick up new channels and rotated epochs. This is
    // a local (IndexedDB) read, but there's no reason to run it while hidden.
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const out: Array<{ relays: string[]; channel: ChannelV2 }> = [];
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community || community.relays.length === 0) continue;
        const keys: GroupKey[] = [];
        const folded = await readFolded<FoldedControl>(controlFoldKey(community.idHex));
        for (const channel of channelsView(community, folded)) {
          if (channel.streams.length === 0) continue;
          out.push({ relays: community.relays, channel });
          keys.push(...channel.streams.map((s) => s.group));
        }
        // Scoped per community, so a relay's NIP-42 challenge only signs the
        // stream keys it actually hosts (see streamAuth.ts).
        registerStreamKeys(keys, community.relays);
      }
      return out;
    },
  });

  return query.data ?? [];
}

/**
 * Every NIP-29 group the user can see, as `{ id, relay }` — discovered PER
 * SERVER, not from the kind-10009 `groups` list.
 *
 * This is the crux of the wire's NIP-29 coverage. A user's 10009 list holds the
 * SERVERS they added (`r` tags) but frequently NO explicit joined-`group`
 * entries — channels are discovered per-relay from the relay-signed kind-39000
 * directory (see useRelayGroups), exactly as the channel list does. If the wire
 * subscribed only to `groupList.groups` it would open ZERO `#h` subscriptions
 * for such servers and their timelines would never ingest (empty servers).
 *
 * So we enumerate the same servers the rail shows (PINNED_RAIL_RELAYS +
 * config.addedRelays) and, per relay, read the group ids from:
 *   - the relay-PROVENANCE-scoped kind-39000 metadata already in the store
 *     (instant, and the common case after a first visit), and
 *   - a bounded live directory read (relay-key-authored) to pick up channels
 *     not yet cached.
 * The union feeds buildWireSpec's `groups`, so the wire holds one `#h` filter
 * per host covering every channel on it.
 */
function useWireNip29Groups(): Array<{ id: string; relay: string }> {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const eventStore = useEventStore();

  const servers = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const url of [...PINNED_RAIL_RELAYS, ...config.addedRelays]) {
      const relay = normalizeRelayUrl(url);
      if (relay && !seen.has(relay)) {
        seen.add(relay);
        out.push(relay);
      }
    }
    return out;
  }, [config.addedRelays]);

  const serversKey = servers.join(",");

  const query = useQuery<Array<{ id: string; relay: string }>>({
    queryKey: ["wire", "nip29-groups", serversKey],
    enabled: servers.length > 0,
    // Relay-signed, rarely-changing directory data. Re-read periodically to
    // pick up newly-created channels; the channel-list UI invalidates on real
    // changes, but the wire keeps its own quiet refresh. Slow, and paused while
    // the tab is hidden.
    staleTime: 60_000,
    refetchInterval: 15 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const perRelay = await Promise.all(
        servers.map(async (relay) => {
          // The relay's own signing key (kind-39000 is authored by it). Best
          // effort — a broken NIP-11 endpoint must not block the others.
          let selfKey: string | undefined;
          try {
            const info = await Promise.race([
              fetchRelayInfoDoc(relay, signal).catch(() => undefined),
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
            ]);
            selfKey = info?.self || info?.pubkey;
          } catch {
            selfKey = undefined;
          }

          // Cache-first from the store (scoped by the relay's key so channels
          // from same-key relays don't bleed). Then a bounded live read.
          const cached = selfKey
            ? await store.query([{ kinds: [KIND_GROUP_METADATA], authors: [selfKey], limit: 500 }])
            : [];
          let live: NostrEvent[] = [];
          try {
            live = await nostr.relay(relay).query(
              [{ kinds: [KIND_GROUP_METADATA], ...(selfKey ? { authors: [selfKey] } : {}), limit: 500 }],
              { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) },
            );
          } catch {
            // Best effort; the cached metadata still yields the known channels.
          }
          return buildRelayGroups([...cached, ...live], relay).map((g) => ({ id: g.id, relay }));
        }),
      );
      return perRelay.flat();
    },
  });

  return query.data ?? [];
}

/**
 * THE funnel. One component owns all standing ingestion:
 *
 *   - builds the wire spec (minimal relays + filters — the same information
 *     the APK's persistent notification service is configured with);
 *   - web: holds ONE subscription per relay through the relay pool (which
 *     handles NIP-42 AUTH — user key + Concord V2 stream keys), resuming from
 *     a persisted per-relay cursor so time offline is replayed;
 *   - APK: bridges the native service's buffered/live events into the same
 *     ingest path;
 *   - drains V2 wraps the native service parked while the WebView was down.
 *
 * Everything lands in IndexedDB (armada-events / the V2 rumor store) and the
 * wire bus announces which conversations changed. Hooks hydrate from the
 * stores; none of them hold their own sockets.
 */
export function WireSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();
  const { data: groupList } = useUserGroupList();
  const { data: followData } = useFollowList();
  const { data: concordData } = useConcordList();
  const concord2 = useWireConcord2Channels();
  const nip29Groups = useWireNip29Groups();

  // NIP-29 groups to subscribe to: the per-server directory discovery (the
  // primary source — see useWireNip29Groups) UNIONed with the kind-10009
  // `groups` list (which additionally carries private/closed channels the open
  // directory hides). De-duplicated by relay+id.
  const groups = useMemo(() => {
    const byKey = new Map<string, { id: string; relay: string }>();
    for (const g of nip29Groups) {
      if (g.id && g.relay) byKey.set(`${g.relay}\u0000${g.id}`, g);
    }
    for (const g of groupList?.groups ?? []) {
      if (g.id && g.relay) byKey.set(`${g.relay}\u0000${g.id}`, { id: g.id, relay: g.relay });
    }
    return [...byKey.values()];
  }, [nip29Groups, groupList?.groups]);

  const spec: WireSpec = useMemo(
    () =>
      buildWireSpec({
        pubkey: user?.pubkey,
        groups,
        dmRelays: effectiveDmRelays(config),
        dmFollows: followData?.pubkeys ?? [],
        concord1: buildConcordSubs(concordData?.list),
        concord2,
      }),
    [user?.pubkey, groups, config, followData?.pubkeys, concordData, concord2],
  );

  // The ingest path reads the spec lazily so long-lived subscriptions always
  // decrypt/scope with the latest keys without resubscribing.
  const specRef = useRef(spec);
  specRef.current = spec;
  const sinksRef = useRef({ eventStore, getSpec: () => specRef.current });
  sinksRef.current = { eventStore, getSpec: () => specRef.current };

  // ── Web sockets: one REQ per relay, resumed from the persisted cursor ─────
  useEffect(() => {
    if (!user || spec.subs.length === 0) return;
    const controller = new AbortController();

    // Per-relay "restart your round now" hooks: aborts the in-flight round and
    // skips any backoff sleep, so the loop re-REQs immediately. Driven by the
    // socket-reopen signal below.
    const bumps = new Map<string, () => void>();
    const offReopen = onRelayReopened((url) => bumps.get(url)?.());

    for (const { relay, filters } of spec.subs) {
      void (async () => {
        // Resubscribe with backoff for the effect's lifetime. NRelay1 keeps
        // the SOCKET alive across drops, but a relay-initiated CLOSED (an
        // auth-gating relay rejecting the REQ before AUTH lands, a policy
        // refusal) terminates the req generator and nothing brings the
        // subscription back until a spec change or app relaunch — on desktop,
        // where there is no native-service funnel, that means no live wire
        // until restart. Each fresh REQ gets a new sub id and with it a fresh
        // auth-retry from the pool, so the wire heals as soon as AUTH lands.
        let backoff = 1_000;
        // Signal-aware, bump-aware sleep: effect cleanup or a socket reopen
        // resolves it early so the retry never lags behind a live socket.
        let wakeSleep: (() => void) | undefined;
        const sleep = (ms: number) =>
          new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(t);
              controller.signal.removeEventListener("abort", finish);
              wakeSleep = undefined;
              resolve();
            };
            const t = setTimeout(finish, ms);
            wakeSleep = finish;
            controller.signal.addEventListener("abort", finish);
          });
        // Routine rotations are silent in the log; only the first round and
        // anomalies (swallowed REQ, reopen restart, early CLOSED) speak.
        let firstRound = true;
        while (!controller.signal.aborted) {
          const started = Date.now();
          // Recompute the resume point each round: the cursor advanced with
          // everything the previous round ingested.
          const now = Math.floor(Date.now() / 1000);
          const cursor = readCursor(relay);
          const floor = now - MAX_CURSOR_AGE_SECONDS;
          const since = Math.max(
            cursor !== undefined ? cursor - CURSOR_OVERLAP_SECONDS : now - FRESH_LOOKBACK_SECONDS,
            cursor !== undefined ? floor : 0,
          );
          // Abortable round, watched for liveness on a recurring tick:
          //   - a round that never yields ANYTHING (no EVENT, no EOSE) inside
          //     SILENT_REQ_TIMEOUT_MS was swallowed — abort and re-REQ;
          //   - an established round silent past QUIET_ROTATE_MS is rotated —
          //     a quiet channel and a silently-dead subscription look
          //     identical from here, and re-REQing from the cursor is
          //     lossless, so never trust one subscription for long;
          //   - a socket reopen bumps the round immediately (see relayReopen).
          const round = new AbortController();
          const roundSignal = AbortSignal.any([controller.signal, round.signal]);
          bumps.set(relay, () => {
            logSync("wire", `${relay}: socket reopened — restarting round`);
            round.abort();
            wakeSleep?.();
          });
          let sawAnything = false;
          let lastMsgAt = started;
          let ingested = 0;
          let rotated = false;
          const watchdog = setInterval(() => {
            const silentFor = Date.now() - lastMsgAt;
            if (!sawAnything && silentFor >= SILENT_REQ_TIMEOUT_MS) {
              logSync("wire", `${relay}: round yielded nothing in ${Math.round(silentFor / 1000)}s — presumed swallowed, re-REQ`);
              round.abort();
            } else if (sawAnything && silentFor >= QUIET_ROTATE_MS) {
              rotated = true;
              round.abort();
            }
          }, WATCHDOG_TICK_MS);
          if (firstRound) {
            logSync("wire", `${relay}: round open (since=${since}, ${filters.length} filter(s))`);
            firstRound = false;
          }
          try {
            for await (const msg of nostr.relay(relay).req(
              filters.map((f) => ({ ...f, since })),
              { signal: roundSignal },
            )) {
              sawAnything = true;
              lastMsgAt = Date.now();
              if (msg[0] === "EVENT") {
                backoff = 1_000;
                const event = msg[2] as NostrEvent;
                await ingestWireEvents(sinksRef.current, [event]);
                ingested += 1;
                writeCursor(relay, event.created_at);
              }
            }
          } catch {
            // Aborted or transport error — handled by the loop condition.
          } finally {
            clearInterval(watchdog);
            // Release the composite roundSignal's grip on the effect
            // controller (a naturally-CLOSED round never aborted its own).
            round.abort();
          }
          if (controller.signal.aborted) break;
          if (!rotated) {
            logSync(
              "wire",
              `${relay}: round ended after ${Math.round((Date.now() - started) / 1000)}s (${ingested} event(s) ingested)`,
            );
          }
          // A session that lived a while earned a prompt retry; a relay
          // slamming the door (CLOSED right away) backs off up to 60s.
          if (Date.now() - started > 60_000) backoff = 1_000;
          await sleep(backoff + Math.floor(Math.random() * 250));
          backoff = Math.min(backoff * 2, 60_000);
        }
      })();
    }
    return () => {
      offReopen();
      controller.abort();
    };
    // Resubscribe only when the actual subscription set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, user?.pubkey, spec.sig]);

  // ── APK bridge: the persistent service is a funnel into the same ingest ──
  useEffect(() => {
    if (!isNativeRuntime()) return;
    let cancelled = false;

    const ingest = (raw: string[]) => {
      const events: NostrEvent[] = [];
      for (const json of raw) {
        try {
          events.push(JSON.parse(json) as NostrEvent);
        } catch {
          // malformed line — skip
        }
      }
      if (events.length > 0 && !cancelled) {
        void ingestWireEvents(sinksRef.current, events);
      }
    };

    // Drain anything buffered while the WebView was down (open / resume).
    const drain = () => {
      ArmadaNotification.drainEvents()
        .then(({ events }) => ingest(events))
        .catch(() => undefined);
    };
    drain();

    let resumeHandle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) drain();
    })
      .then((h) => {
        if (cancelled) h.remove();
        else resumeHandle = h;
      })
      .catch(() => undefined);

    let liveHandle: { remove: () => void } | undefined;
    ArmadaNotification.addListener("relayEvent", ({ event }) => {
      ingest([event]);
    })
      .then((h) => {
        if (cancelled) h.remove();
        else liveHandle = h;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      liveHandle?.remove();
      resumeHandle?.remove();
    };
  }, []);

  // ── Parked-wrap drain: decrypt what the service left us, as keys appear ──
  useEffect(() => {
    if (spec.v2ByPk.size === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const parked = await peekPendingWraps([...spec.v2ByPk.keys()]);
        if (parked.length === 0 || cancelled) return;
        const scopes = new Set<string>();
        const acked: string[] = [];
        const byChannel = new Map<ChannelV2, NostrEvent[]>();
        for (const wrap of parked) {
          const channel = spec.v2ByPk.get(wrap.pubkey);
          if (!channel) continue;
          const list = byChannel.get(channel);
          if (list) list.push(wrap);
          else byChannel.set(channel, [wrap]);
        }
        for (const [channel, wraps] of byChannel) {
          const opened = await openChatBatch(wraps, channel);
          if (opened.length === 0) continue;
          writeRumors(opened);
          scopes.add(`c2:${channel.idHex}`);
          const openedWrapIds = new Set(opened.map((o) => o.wrapId));
          acked.push(...wraps.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
        }
        ackPendingWraps(acked);
        if (scopes.size > 0) emitWireScopes(scopes);
      } catch {
        // Best-effort — wraps stay parked for the next pass.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.sig]);

  return null;
}

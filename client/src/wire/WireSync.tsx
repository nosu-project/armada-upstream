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
import { readFolded } from "@/lib/foldedCache";
import { ArmadaNotification } from "@/lib/nativeNotifications";
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
    const prev = readCursor(relay) ?? 0;
    if (createdAt > prev) localStorage.setItem(cursorKey(relay), String(createdAt));
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
    // re-read periodically to pick up new channels and rotated epochs.
    refetchInterval: 60_000,
    queryFn: async () => {
      const out: Array<{ relays: string[]; channel: ChannelV2 }> = [];
      const keys: GroupKey[] = [];
      for (const entry of entries) {
        const community = rehydrateCommunity(entry);
        if (!community || community.relays.length === 0) continue;
        const folded = await readFolded<FoldedControl>(controlFoldKey(community.idHex));
        for (const channel of channelsView(community, folded)) {
          if (channel.streams.length === 0) continue;
          out.push({ relays: community.relays, channel });
          keys.push(...channel.streams.map((s) => s.group));
        }
      }
      registerStreamKeys(keys);
      return out;
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

  const spec: WireSpec = useMemo(
    () =>
      buildWireSpec({
        pubkey: user?.pubkey,
        groups: groupList?.groups ?? [],
        dmRelays: effectiveDmRelays(config),
        dmFollows: followData?.pubkeys ?? [],
        concord1: buildConcordSubs(concordData?.list),
        concord2,
      }),
    [user?.pubkey, groupList, config, followData?.pubkeys, concordData, concord2],
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
    const now = Math.floor(Date.now() / 1000);

    for (const { relay, filters } of spec.subs) {
      const cursor = readCursor(relay);
      const floor = now - MAX_CURSOR_AGE_SECONDS;
      const since = Math.max(
        cursor !== undefined ? cursor - CURSOR_OVERLAP_SECONDS : now - FRESH_LOOKBACK_SECONDS,
        cursor !== undefined ? floor : 0,
      );
      void (async () => {
        try {
          for await (const msg of nostr.relay(relay).req(
            filters.map((f) => ({ ...f, since })),
            { signal: controller.signal },
          )) {
            if (msg[0] === "EVENT") {
              const event = msg[2] as NostrEvent;
              await ingestWireEvents(sinksRef.current, [event]);
              writeCursor(relay, event.created_at);
            }
          }
        } catch {
          // Subscription ended. NRelay1 reconnects transparently; a spec
          // change (or app relaunch, from the cursor) resubscribes.
        }
      })();
    }
    return () => controller.abort();
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

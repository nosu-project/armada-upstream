import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAppContext } from "@/hooks/useAppContext";
import { useEventStore } from "@/hooks/useEventStore";
import { useBlossomServers } from "@/hooks/useBlossomServers";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useMediaPolicy } from "@/hooks/useMediaPolicy";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useNotifLevels, type NotifLevel } from "@/hooks/useNotifLevels";
import { channelReadKey, useReadState } from "@/hooks/useReadState";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { parseAuthorEvent, seedAuthorCache, type AuthorResult } from "@/lib/authorCache";
import { isForegroundNotifyReady } from "@/hooks/useForegroundNotificationSettings";
import { resolveDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { FUTURE_HOLD_MS } from "@/concord/lib/stream";
import { isRoomActive } from "@/lib/activeRooms";
import { isDesktop, requestDesktopAttention } from "@/lib/desktop";
import { desktopNotificationTag } from "@/lib/desktopNotificationTag";
import { getDisplayName } from "@/lib/getDisplayName";
import { mediaSrc } from "@/lib/mediaPolicy";
import { queryDm17Conversations } from "@/lib/nip17/dm17Store";
import { dmConvPeers } from "@/lib/nip17/conversation";
import {
  attributedLine,
  mentionPubkeys,
  NOTIFICATION_BADGE_ICON,
  NOTIFICATION_FALLBACK_ICON,
  presentNotification,
  type NotificationMessage,
  type PresentedNotification,
} from "@/lib/notificationPreview";
import { concordRoomIdentity, nip29RoomIdentity } from "@/lib/notificationRoom";
import {
  loadNotificationSoundSettings,
  playNotificationSound,
} from "@/lib/notificationSounds";
import { isNativeRuntime, normalizeRelayUrl } from "@/lib/platform";
import {
  notificationPolicyIsAuthoritative,
  useNotificationSettingsReady,
} from "@/lib/notificationSettingsAuthority";
import { chatRoute, parseChatRoute } from "@/lib/routes";
import {
  installTabAttentionClearHandlers,
  markTabAttention,
} from "@/lib/tabAttention";
import { registerNotifySink, type NotifyCandidate } from "@/wire/notify";
import { useWireNip29Groups } from "@/wire/useWireNip29Groups";

import type { NostrMetadata } from "@nostrify/nostrify";

/**
 * Client-side notifier while Armada is OPEN (web/desktop; native uses its service). Turns the
 * wire's unread/mention candidates into an OS Notification, an in-app sound and a tab marker.
 * Gates: the resolved notification level (`useNotifLevels`), not the on-screen room, not already
 * read (`useReadState`), and newer than session start and the room's last notification.
 * Intent + OS permission gate only the system Notification; sound and tab marker need neither.
 */

/**
 * Per-room ceiling, mirroring `sw.js`'s `ROOM_ALERT_*` and native `ALERT_BURST_MAX`: past it,
 * notifications post without sound.
 */
const ROOM_ALERT_MAX = 5;
const ROOM_ALERT_WINDOW_MS = 120_000;
const ROOM_ALERT_MAX_TRACKED = 64;

function levelAdmits(level: NotifLevel, mention: boolean): boolean {
  if (level === "nothing") return false;
  if (level === "mentions") return mention;
  return true; // "all"
}

/**
 * The page may show an OS notification only after proving there's no Web Push
 * subscription. Fail closed to avoid duplicates.
 */
export async function pageMayShowOsNotification(): Promise<boolean> {
  // Desktop (app://armada) throws SecurityError on service-worker lookups and has no Web Push,
  // so the page always owns presentation there.
  if (isDesktop()) return true;
  if (!("serviceWorker" in navigator)) return true;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return true;
    return !(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
}

export interface PageNotificationCoordination {
  allowActivePush?: boolean;
  shouldAbort?: () => boolean;
  onPresenting?: () => void;
}

/**
 * Present via the registration when possible: mobile WebKit rejects the page Notification
 * constructor for installed apps. Registration notifications route clicks through sw.js.
 */
export async function showPageOsNotification(
  title: string,
  options: NotificationOptions,
  coordination: PageNotificationCoordination = {},
): Promise<Notification | null | undefined> {
  const abort = () => coordination.shouldAbort?.() === true;
  let presenting = false;
  const beginPresentation = () => {
    if (presenting) return;
    presenting = true;
    coordination.onPresenting?.();
  };

  if (abort()) return null;
  // Electron's `registration.showNotification()` draws nothing; the page constructor does
  // reach the OS, so desktop takes that path.
  const preferPageConstructor = isDesktop();
  if (!preferPageConstructor && "serviceWorker" in navigator) {
    try {
      const current = await navigator.serviceWorker.getRegistration();
      if (current) {
        // A subscription may have been enabled meanwhile; `null` hands the event to the PushEvent.
        if (!coordination.allowActivePush && await current.pushManager.getSubscription()) {
          return null;
        }
        const registration = await navigator.serviceWorker.ready;
        if (abort()) return null;
        if (!coordination.allowActivePush && await registration.pushManager.getSubscription()) {
          return null;
        }
        if (abort()) return null;
        beginPresentation();
        await registration.showNotification(title, options);
        return undefined;
      }
    } catch {
      // One last no-subscription proof before the constructor fallback.
      try {
        const current = await navigator.serviceWorker.getRegistration();
        if (
          !coordination.allowActivePush
          && current
          && await current.pushManager.getSubscription()
        ) return null;
      } catch {
        return null; // indeterminate ownership: fail closed against duplicates
      }
    }
  }
  if (abort()) return null;
  beginPresentation();
  return new Notification(title, options);
}

function rasterizeFirstFrame(url: string, size = 128): Promise<string | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    // Without CORS `toDataURL` throws on cross-origin images (all avatars, from app://armada).
    img.crossOrigin = "anonymous";
    let settled = false;
    const done = (value?: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return done(undefined);
        ctx.drawImage(img, 0, 0, size, size);
        done(canvas.toDataURL("image/png"));
      } catch {
        done(undefined); // tainted canvas: host sent no CORS headers
      }
    };
    img.onerror = () => done(undefined);
    img.src = url;
    setTimeout(() => done(undefined), 4000);
  });
}

/**
 * libnotify renders an animated GIF icon blank, so flatten a GIF to a static PNG (dropped if
 * CORS blocks it). Non-GIFs pass through.
 */
export async function desktopSafeNotificationIcon(
  icon: string | undefined,
): Promise<string | undefined> {
  if (!icon || !isDesktop()) return icon;
  if (!/^https:\/\//i.test(icon) || !/\.gif(\?|#|$)/i.test(icon)) return icon;
  return await rasterizeFirstFrame(icon);
}

/**
 * Clear the accumulated body of rooms read up to the newest notified message, so the next
 * message starts fresh. Rooms without a read key are untouched.
 */
export function retireSeenRoomLines(
  roomLines: Map<string, string[]>,
  roomReadKeys: Map<string, string>,
  lastNotified: Map<string, number>,
  alertTimes: Map<string, number[]>,
  readState: Record<string, number>,
): void {
  for (const [roomKey, lines] of roomLines) {
    if (lines.length === 0) continue;
    const readKey = roomReadKeys.get(roomKey);
    const lastAt = lastNotified.get(roomKey) ?? 0;
    if (readKey && lastAt > 0 && (readState[readKey] ?? 0) >= lastAt) {
      roomLines.delete(roomKey);
      alertTimes.delete(roomKey);
    }
  }
}

export type PagePushOutcome = "presenting" | "presented" | "suppressed";

interface PagePushState {
  roomKey: string;
  outcome: PagePushOutcome;
}

/** Resolve NIP-29's relay-scoped key before common self/mute/session gates. */
export function foregroundPushRoomKey(
  candidate: Pick<NotifyCandidate, "plane" | "roomKey" | "relayUrl" | "groupId">,
  relayByGroup: ReadonlyMap<string, string>,
): string {
  if (candidate.plane !== "nip29" || !candidate.groupId) return candidate.roomKey;
  const relay = candidate.relayUrl
    ? normalizeRelayUrl(candidate.relayUrl) ?? candidate.relayUrl
    : relayByGroup.get(candidate.groupId);
  return relay ? `h:${relay}|${candidate.groupId}` : candidate.roomKey;
}

export function useForegroundNotifications(): void {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const durableNotificationSettingsReady = useNotificationSettingsReady(user?.pubkey);
  const notificationSettingsReady = notificationPolicyIsAuthoritative(
    durableNotificationSettingsReady,
    config.automaticSettingsSync,
  );
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  useNostr(); // keep within the Nostr provider tree

  const { readState } = useReadState();
  const { channelLevel, concordChannelLevel, dmLevel } = useNotifLevels();
  const { isKnown, knownConversationKeys } = useKnownDmPeers();
  const knownConversationSet = useMemo(
    () => new Set(knownConversationKeys),
    [knownConversationKeys],
  );
  const { data: groupList } = useUserGroupList();
  const { mutedPubkeys } = useMutedPubkeys();
  // The OS fetches the icon from the sender-named host, so apply the avatar media policy.
  const mediaPolicy = useMediaPolicy();
  const blossomServers = useBlossomServers();

  // Own ref so the sink sees a fresh mute without re-registering.
  const mutedRef = useRef(mutedPubkeys);
  mutedRef.current = mutedPubkeys;

  // Fallback for legacy candidates without ingest's exact source relay. Duplicate ids across
  // relays are removed rather than guessed.
  const wireGroups = useWireNip29Groups();
  const relayByGroup = useMemo(() => {
    const m = new Map<string, string>();
    const ambiguous = new Set<string>();
    const add = (id: string, rawRelay: string) => {
      const relay = normalizeRelayUrl(rawRelay);
      if (!relay || !id || ambiguous.has(id)) return;
      const held = m.get(id);
      if (held && held !== relay) {
        m.delete(id);
        ambiguous.add(id);
      } else if (!held) {
        m.set(id, relay);
      }
    };
    for (const g of groupList?.groups ?? []) {
      add(g.id, g.relay);
    }
    for (const g of wireGroups) {
      if (g.id && g.relay) add(g.id, g.relay);
    }
    return m;
  }, [groupList, wireGroups]);

  // Refs so the stable sink reads current values; re-registering drops the wire's reference.
  const ctx = useRef({
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    isKnown,
    knownConversationSet,
    relayByGroup,
    navigate,
    queryClient,
    eventStore,
    dmRequestPolicy: config.pushPrefs.dmRequests,
    mediaPolicy,
    blossomServers,
  });
  ctx.current = {
    readState,
    channelLevel,
    concordChannelLevel,
    dmLevel,
    isKnown,
    knownConversationSet,
    relayByGroup,
    navigate,
    queryClient,
    eventStore,
    dmRequestPolicy: config.pushPrefs.dmRequests,
    mediaPolicy,
    blossomServers,
  };

  // Session floor: a fresh login backfilling history must stay silent.
  const sessionFloor = useRef(Math.floor(Date.now() / 1000));
  // Per-room high-water mark so overlapping transports / re-ingests don't double-alert.
  const lastNotified = useRef(new Map<string, number>());
  const notifiedEvents = useRef(new Set<string>());
  // Arbitrate the live page against its PushEvent; session-only and bounded.
  const pagePushStates = useRef(new Map<string, PagePushState>());
  const workerOwnedPushes = useRef(new Map<string, string>());
  const alertTimes = useRef(new Map<string, number[]>());
  const roomLines = useRef(new Map<string, string[]>());
  const roomReadKeys = useRef(new Map<string, string>());

  // Room keys (not flattened participants) are load-bearing for group privacy.
  const mineConversationKeys = useRef(new Set<string>());
  const mineLoading = useRef(false);

  // Retire a room's body once read (here or elsewhere), or the collapsed notification's body
  // only ever grows.
  useEffect(() => {
    retireSeenRoomLines(
      roomLines.current,
      roomReadKeys.current,
      lastNotified.current,
      alertTimes.current,
      readState,
    );
  }, [readState]);

  useEffect(() => {
    if (!user) return;
    // Mounted outside SyncGate: stay silent until the encrypted notification policy (or a
    // relay-backed absence proof) has been applied.
    if (!notificationSettingsReady) return;
    if (isNativeRuntime()) return; // native has its own background service

    const removeTabAttentionHandlers = installTabAttentionClearHandlers();
    let mounted = true;

    const trimExactMap = <T,>(map: Map<string, T>) => {
      if (map.size <= 512) return;
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    };
    const exactState = (eventId: string, roomKey: string) => {
      const state = pagePushStates.current.get(eventId);
      return state?.roomKey === roomKey ? state : undefined;
    };
    const stateForWorkerRequest = (eventId: string, roomKey: string) => {
      const state = pagePushStates.current.get(eventId);
      return !roomKey || state?.roomKey === roomKey ? state : undefined;
    };
    const workerOwns = (eventId: string | undefined, roomKey: string) => (
      Boolean(eventId && roomKey && (
        workerOwnedPushes.current.get(eventId) === roomKey
        || workerOwnedPushes.current.get(eventId) === "*"
      ))
    );
    const recordPushState = (
      eventId: string | undefined,
      roomKey: string,
      outcome: PagePushOutcome,
    ) => {
      if (!eventId || !roomKey) return;
      const prior = exactState(eventId, roomKey);
      // Never downgrade a completed presentation.
      if (prior?.outcome === "presented" && outcome !== "presented") return;
      pagePushStates.current.set(eventId, { roomKey, outcome });
      trimExactMap(pagePushStates.current);
    };
    const clearPresenting = (eventId: string | undefined, roomKey: string) => {
      if (!eventId) return;
      if (exactState(eventId, roomKey)?.outcome === "presenting") {
        pagePushStates.current.delete(eventId);
      }
    };
    const claimForWorker = (eventId: string, roomKey: string) => {
      workerOwnedPushes.current.set(eventId, roomKey);
      trimExactMap(workerOwnedPushes.current);
    };

    const answerPushPresentationQuery = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-presentation-query") return;
      const port = event.ports[0];
      const eventId = typeof event.data.eventId === "string" ? event.data.eventId : "";
      const roomKey = typeof event.data.roomKey === "string" ? event.data.roomKey : "";
      if (!port || !eventId) return;

      void (async () => {
        // Let a running live candidate finish; the worker claims explicitly if unhandled.
        for (let i = 0; i < 8; i++) {
          const state = stateForWorkerRequest(eventId, roomKey);
          if (state && state.outcome !== "presenting") {
            port.postMessage({ eventId, roomKey: state.roomKey, outcome: state.outcome });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (!mounted) return;
        }
        const pending = stateForWorkerRequest(eventId, roomKey);
        port.postMessage({
          eventId,
          roomKey: pending?.roomKey ?? roomKey,
          outcome: pending?.outcome ?? "unhandled",
        });
      })();
    };
    navigator.serviceWorker?.addEventListener("message", answerPushPresentationQuery);

    const answerWorkerClaim = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-worker-claim") return;
      const port = event.ports[0];
      const eventId = typeof event.data.eventId === "string" ? event.data.eventId : "";
      const roomKey = typeof event.data.roomKey === "string" ? event.data.roomKey : "";
      if (!port || !eventId) return;

      void (async () => {
        // Let an already-issued page presentation settle before the claim wins.
        for (let i = 0; i < 12; i++) {
          const state = stateForWorkerRequest(eventId, roomKey);
          if (!state || state.outcome !== "presenting") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (!mounted) return;
        }
        const state = stateForWorkerRequest(eventId, roomKey);
        if (state) {
          port.postMessage({ eventId, roomKey: state.roomKey, outcome: state.outcome });
          return;
        }
        // Wildcard claim when the worker couldn't resolve a NIP-29 room; the event id is exact.
        claimForWorker(eventId, roomKey || "*");
        port.postMessage({ eventId, roomKey, outcome: "worker" });
      })();
    };
    navigator.serviceWorker?.addEventListener("message", answerWorkerClaim);

    // Local reads only (author cache, then event store kind-0), so a missing profile never
    // delays the notification. No profile → "Anonymous", matching Android and `getDisplayName`.
    const profileFor = async (pubkey: string): Promise<{ name: string; avatar?: string }> => {
      const present = (metadata: NostrMetadata | undefined) => ({
        name: getDisplayName(metadata, pubkey),
        // https only (http is a failing mixed-content fetch), then the media policy.
        avatar: mediaSrc(
          typeof metadata?.picture === "string" && /^https:\/\//.test(metadata.picture)
            ? metadata.picture
            : undefined,
          ctx.current.mediaPolicy,
        ),
      });

      if (!pubkey) return { name: "Anonymous" };
      const qc = ctx.current.queryClient;
      const cached = qc.getQueryData<AuthorResult>(["author", pubkey]);
      if (cached?.metadata) return present(cached.metadata);
      if (cached?.event) return present(parseAuthorEvent(cached.event).metadata);

      // Local event store fallback (no network).
      try {
        const store = await ctx.current.eventStore;
        const [ev] = await store.query([{ kinds: [0], authors: [pubkey], limit: 1 }]);
        if (ev) {
          const parsed = parseAuthorEvent(ev);
          seedAuthorCache(qc, pubkey, ev);
          if (parsed.metadata) return present(parsed.metadata);
        }
      } catch {
        // Store unavailable — fall through.
      }

      return { name: "Anonymous" };
    };

    /** Room title and icon, matching the Android conversation shortcut. Local reads only. */
    const roomIdentityFor = async (
      cand: NotifyCandidate,
      relayUrl: string | undefined,
      communityId: string | undefined,
    ): Promise<{ title?: string; image?: string }> => {
      try {
        if (cand.plane === "nip29") {
          if (!relayUrl || !cand.groupId) return {};
          const room = await nip29RoomIdentity(relayUrl, cand.groupId);
          // A kind-39000 `picture` is the relay operator's URL: policed like an avatar.
          return { title: room.title, image: mediaSrc(room.iconUrl, ctx.current.mediaPolicy) };
        }
        if (cand.plane === "c2") {
          if (!communityId || !cand.channelIdHex) return {};
          const room = await concordRoomIdentity(communityId, cand.channelIdHex);
          // Encrypted blob; usually a warm Cache Storage hit.
          const image = room.iconPointer
            ? await resolveDecryptedImage(room.iconPointer, ctx.current.blossomServers, ctx.current.mediaPolicy)
              .catch(() => undefined)
            : undefined;
          return { title: room.title, image };
        }
      } catch {
        // Never let room decoration cost the notification itself.
      }
      return {};
    };

    const mentionNamesFor = async (content: string | undefined): Promise<Map<string, string>> => {
      const names = new Map<string, string>();
      if (!content) return names;
      const keys = mentionPubkeys(content);
      if (keys.length === 0) return names;
      await Promise.all(keys.map(async (pk) => {
        const { name } = await profileFor(pk);
        // "Anonymous" is an absence; the raw token means more.
        if (name && name !== "Anonymous") names.set(pk, name);
      }));
      return names;
    };

    /**
     * Past the ceiling, still shown but silent. Records every attempt so a sustained flood stays
     * quiet until it stops.
     */
    const roomAlertSilent = (roomKey: string): boolean => {
      const now = Date.now();
      const times = (alertTimes.current.get(roomKey) ?? [])
        .filter((t) => now - t <= ROOM_ALERT_WINDOW_MS);
      const silent = times.length >= ROOM_ALERT_MAX;
      times.push(now);
      alertTimes.current.set(
        roomKey,
        times.length > ROOM_ALERT_MAX_TRACKED ? times.slice(-ROOM_ALERT_MAX_TRACKED) : times,
      );
      return silent;
    };

    const appendRoomLine = (roomKey: string, line: string): string[] => {
      const lines = [...(roomLines.current.get(roomKey) ?? []).slice(-4), line];
      roomLines.current.set(roomKey, lines);
      return lines;
    };

    // Reload rooms the viewer authored in, on mount and when an unknown DM arrives (they may have
    // replied since; `acceptedDms` is only written from the compose pane).
    const refreshMineConversationKeys = () => {
      if (mineLoading.current) return;
      mineLoading.current = true;
      void (async () => {
        try {
          const rows = await queryDm17Conversations(user.pubkey);
          // A written group makes that conversation known, not each member in unrelated 1:1s.
          mineConversationKeys.current = new Set(
            rows.filter((row) => row.mine).map((row) => row.key),
          );
        } catch {
          // Store unavailable — follows ∪ accepted ∪ pinned still apply.
        } finally {
          mineLoading.current = false;
        }
      })();
    };
    refreshMineConversationKeys();

    const unregister = registerNotifySink((candidates) => {
      const canShowOsNotification = isForegroundNotifyReady();
      const soundSettings = loadNotificationSoundSettings();
      let playedSound = false;
      // One ownership proof per batch. The in-app sound is NOT gated on it (OS notifications are
      // always `silent: true`).
      let pageOwnership: Promise<boolean> | undefined;
      const pageOwnsPresentation = () => (
        pageOwnership ??= pageMayShowOsNotification()
      );

      const c = ctx.current;

      for (const cand of candidates) {
        const initialRoomKey = foregroundPushRoomKey(cand, c.relayByGroup);
        const suppress = (key: string) => recordPushState(
          cand.eventId,
          key,
          "suppressed",
        );
        if (cand.createdAt <= sessionFloor.current) {
          suppress(initialRoomKey);
          continue;
        }
        // Hold future-dated candidates like the timeline does (FUTURE_HOLD_MS); they re-arrive later.
        if (cand.createdAt * 1000 > Date.now() + FUTURE_HOLD_MS) {
          suppress(initialRoomKey);
          continue;
        }
        // Belt-and-braces: ingest normally drops self-authored events.
        if (cand.author && cand.author === user.pubkey) {
          suppress(initialRoomKey);
          continue;
        }
        // A muted person must not raise any cue.
        if (cand.author && mutedRef.current.has(cand.author)) {
          suppress(initialRoomKey);
          continue;
        }

        let roomKey = initialRoomKey;
        let readKey = cand.readKey;
        let path = cand.path;
        let level: NotifLevel;
        // Unknown DM sender under the "generic" request policy: cue but show nothing they control.
        let dmGeneric = false;
        let relayUrl: string | undefined;
        let communityId: string | undefined;

        if (cand.plane === "nip29") {
          const relay = cand.relayUrl
            ? normalizeRelayUrl(cand.relayUrl) ?? cand.relayUrl
            : cand.groupId ? c.relayByGroup.get(cand.groupId) : undefined;
          if (!relay || !cand.groupId) {
            suppress(initialRoomKey);
            continue; // not a group we're in
          }
          relayUrl = relay;
          roomKey = `h:${relay}|${cand.groupId}`;
          readKey = channelReadKey(relay, cand.groupId);
          path = chatRoute({
            kind: "nip29",
            relayUrl: relay,
            groupId: cand.groupId,
            messageId: cand.eventId,
          });
          level = c.channelLevel(relay, cand.groupId);
        } else if (cand.plane === "dm") {
          // Match the DM list: a group with any muted participant is hidden.
          if (cand.peer && dmConvPeers(cand.peer).some((peer) => mutedRef.current.has(peer))) {
            suppress(roomKey);
            continue;
          }
          level = cand.peer ? c.dmLevel(cand.peer) : "all";
          // Unknown senders control text, name and avatar: apply the request policy ("off" silent,
          // "generic" content-free, "full" normal).
          const conversationKnown = cand.peer
            ? c.knownConversationSet.has(cand.peer)
              || mineConversationKeys.current.has(cand.peer)
              || dmConvPeers(cand.peer).every((peer) => c.isKnown(peer, false))
            : true;
          if (cand.peer && !conversationKnown) {
            // The viewer may have written to them since the set was loaded.
            refreshMineConversationKeys();
            const policy = c.dmRequestPolicy;
            if (policy === "off") {
              suppress(roomKey);
              continue;
            }
            if (policy !== "full") dmGeneric = true;
          }
        } else {
          if (!path) {
            suppress(roomKey);
            continue; // couldn't resolve the community route
          }
          // Parsed (not split): the route may carry `/m/<id>`; git candidates carry `?ticket=`.
          const parsed = parseChatRoute(path.split("?")[0]);
          communityId = parsed?.kind === "concord" ? parsed.communityId : "";
          level =
            communityId && cand.channelIdHex
              ? c.concordChannelLevel("c2", communityId, cand.channelIdHex)
              : "all";
        }

        if (!levelAdmits(level, cand.mention)) {
          suppress(roomKey);
          continue;
        }

        if (readKey && (c.readState[readKey] ?? 0) >= cand.createdAt) {
          suppress(roomKey);
          continue;
        }

        // Only while the Armada window is focused on this room.
        if (isRoomActive(roomKey)) {
          suppress(roomKey);
          continue;
        }

        const eventKey = cand.eventId ? `${roomKey}:${cand.eventId}` : "";
        if (eventKey && notifiedEvents.current.has(eventKey)) {
          suppress(roomKey);
          continue;
        }
        const mark = lastNotified.current.get(roomKey) ?? 0;
        // Legacy candidates lack an event id, so dedupe by timestamp; git events have source ids.
        if (!eventKey && cand.createdAt <= mark) {
          suppress(roomKey);
          continue;
        }
        lastNotified.current.set(roomKey, cand.createdAt);
        if (eventKey) notifiedEvents.current.add(eventKey);
        // Lets a read clear the accumulated body.
        if (readKey) roomReadKeys.current.set(roomKey, readKey);

        // Content-blind rate limiting: anyone with the invite can flood a channel.
        const silent = roomAlertSilent(roomKey);

        // Page-owned cues need no permission; one sound per batch. The favicon badge is idempotent.
        markTabAttention();

        // Play the sound here at ingest, not after the presentation handoff: the worker can't play
        // audio and OS notifications are always silent.
        if (soundSettings.enabled && !playedSound && !silent) {
          playNotificationSound({ settings: soundSettings });
          playedSound = true;
        }

        const canCoordinateExactEvent = () => Boolean(
          cand.eventId
          && roomKey
          && document.visibilityState === "visible"
          && document.hasFocus(),
        );

        if (!canShowOsNotification) continue;

        // Errors are swallowed so one bad event never breaks the batch.
        void (async () => {
          // A visible page may cover a missing PushEvent only for exact events the worker can arbitrate.
          if (!canCoordinateExactEvent() && !(await pageOwnsPresentation())) return;
          if (workerOwns(cand.eventId, roomKey)) return;
          // Composing is deferred past the last active-room check so an unshown notification leaves no
          // line in the room body.
          let presented: PresentedNotification | undefined;
          let message: NotificationMessage | undefined;
          let notificationLines: string[] | undefined;

          if (cand.plane === "dm" && dmGeneric) {
            // Content-blind: nothing the sender controls (name/avatar/text).
            presented = {
              title: "Message request",
              body: "You have a new message request",
              icon: NOTIFICATION_FALLBACK_ICON,
              badge: NOTIFICATION_BADGE_ICON,
            };
          } else if (cand.git) {
            // Repository activity keeps its own shape rather than going through the presenter.
            const { name, avatar } = await profileFor(cand.author);
            presented = {
              title: `${name} ${cand.git.action} in ${cand.git.repository}`,
              body: cand.git.ticketTitle ?? "New activity in the destination channel",
              icon: avatar ?? NOTIFICATION_FALLBACK_ICON,
              badge: NOTIFICATION_BADGE_ICON,
            };
          } else {
            const [{ name, avatar }, room, mentionNames] = await Promise.all([
              profileFor(cand.author),
              roomIdentityFor(cand, relayUrl, communityId),
              mentionNamesFor(cand.content),
            ]);
            message = {
              plane: cand.plane,
              kind: cand.kind,
              // `body` is truncated; `content` is the raw text the preview pipeline needs.
              content: cand.content ?? cand.body ?? "",
              authorName: name,
              authorAvatar: avatar,
              roomTitle: room.title,
              roomImage: room.image,
              mention: cand.mention,
              reaction: cand.reaction,
              threadReply: cand.threadReply,
              imetaMime: cand.imetaMime,
              mentionNames,
            };
          }

          try {
            // Re-check: the user may have focused the conversation during profile resolution.
            if (cand.author === user.pubkey || isRoomActive(roomKey)) {
              suppress(roomKey);
              return;
            }
            // Accumulate lines so a busy room reads as a thread (like native MessagingStyle).
            if (message) {
              notificationLines = appendRoomLine(roomKey, attributedLine(message));
              presented = presentNotification(
                message,
                notificationLines,
              );
            }
            if (!presented) return;
            // libnotify draws animated GIF icons blank.
            const icon = await desktopSafeNotificationIcon(presented.icon);
            const allowActivePush = canCoordinateExactEvent();
            const n = await showPageOsNotification(presented.title, {
              body: presented.body,
              icon,
              badge: presented.badge,
              // Armada plays its own sound; avoid the browser's default tone.
              silent: true,
              // Tag by room to collapse repeats. Desktop digests it: the raw key overflows Windows'
              // toast tag limit (desktopNotificationTag.ts).
              tag: isDesktop() ? desktopNotificationTag(roomKey) : roomKey || "armada",
              // sw.js handles registration notification clicks, so carry the SPA route.
              data: { url: path || "/", lines: notificationLines },
            }, {
              allowActivePush,
              shouldAbort: () => (
                workerOwns(cand.eventId, roomKey)
                || (allowActivePush && !canCoordinateExactEvent())
              ),
              onPresenting: () => recordPushState(cand.eventId, roomKey, "presenting"),
            });
            if (n === null) {
              clearPresenting(cand.eventId, roomKey);
              return;
            }
            recordPushState(cand.eventId, roomKey, "presented");
            if (n) {
              n.onclick = () => {
                window.focus();
                if (path) c.navigate(path);
                n.close();
              };
              // A toast Windows refuses surfaces only here; log it.
              n.onerror = () => {
                console.warn("[notify] OS refused the notification", { roomKey, title: n.title });
              };
              // Taskbar flash on desktop; no-op on the web and when focused.
              if (isDesktop()) requestDesktopAttention();
            }
          } catch {
            clearPresenting(cand.eventId, roomKey);
            // Permission may have changed after the initial gate.
          }
        })();
      }
    });

    return () => {
      mounted = false;
      unregister();
      removeTabAttentionHandlers();
      navigator.serviceWorker?.removeEventListener("message", answerPushPresentationQuery);
      navigator.serviceWorker?.removeEventListener("message", answerWorkerClaim);
    };
  }, [user, notificationSettingsReady]);
}

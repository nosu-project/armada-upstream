import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { MediaPolicyConfig } from "@/lib/mediaPolicy";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Bridge to the Android background notification service
 * (ArmadaNotificationPlugin.java): a persistent relay REQ that posts native
 * notifications without FCM. No-ops on iOS/web.
 */
/**
 * A community icon for the Android group summary: a public URL, or an encrypted
 * blob the service fetches and AES-256-GCM decrypts (`key`/`nonce` hex, `hash`
 * = hex SHA-256 of plaintext, verified so a swapped blob fails closed).
 */
export interface CommunityNotifImage {
  url: string;
  key?: string;
  nonce?: string;
  hash?: string;
}

/** Android's non-secret diagnostic snapshot for the local notification path. */
export interface NativeNotificationHealth {
  postNotificationsGranted: boolean;
  notificationsEnabled: boolean;
  /** Android NotificationManager importance, or -1 where channels do not apply. */
  messageChannelImportance: number;
  callChannelImportance: number;
  serviceChannelImportance: number;
  /** All currently posted Armada notifications, including the foreground-service row. */
  activeNotificationCount: number;
  serviceRunning: boolean;
  configEnabled: boolean;
  configRevision: number;
  loadedConfigRevision: number;
  lastConfigAt: number;
  relayWatchCount: number;
  groupWatchCount: number;
  dmPeerWatchCount: number;
  concordStreamWatchCount: number;
  socketOpenCount: number;
  socketTotalCount: number;
  signerStatus: "ready" | "missing" | "unavailable";
  authStatus: "idle" | "challenged" | "signed" | "accepted" | "rejected" | "failed";
  lastAuthAt: number;
  lastSignAt: number;
  lastEventAt: number;
  lastPresentedAt: number;
  lastErrorAt: number;
  /** Stable error category only; never relay URLs, event bodies, or credentials. */
  lastError?: string;
  /** Profiling builds only (`-ParmadaProfile=true`). Labels include relay hosts. */
  profile?: Record<string, unknown>;
}

export interface ArmadaNotificationPlugin {
  /** Whether POST_NOTIFICATIONS is granted (always true below Android 13). */
  checkPermission(): Promise<{ granted: boolean }>;
  /** Prompt for POST_NOTIFICATIONS (Android 13+). */
  requestPermission(): Promise<{ granted: boolean }>;
  getHealth(): Promise<NativeNotificationHealth>;
  /** Open Android's app-level or one-channel notification settings screen. */
  openNotificationSettings(options: {
    channel?: "messages" | "calls" | "service";
  }): Promise<void>;
  /**
   * Whether exempt from battery optimizations: Doze kills the relay sockets, and
   * on Android 15+ the boot receiver needs the exemption.
   */
  isIgnoringBatteryOptimizations(): Promise<{ ignoring: boolean }>;
  /** Android: show the one-tap system dialog to grant the exemption. */
  requestIgnoreBatteryOptimizations(): Promise<void>;
  /** Hand a signed NIP-42 kind-22242 event back to the service. */
  submitAuth(options: { relayUrl: string; event: NostrEvent }): Promise<void>;
  /**
   * Drain one relay's page of raw wire events (oldest first) for JS ingest, then
   * {@link ackDrain}. Events are already in ArmadaDB; the drain is for routing.
   * `relay` names the queue tenant — it can't live in the rumor (tags are signed
   * and forgeable). Absent only for the pre-upgrade unscoped queue.
   */
  drainEvents(): Promise<{ events: string[]; ids: string[]; relay?: string }>;
  /** Drop an ingested page; `relay` must be the value {@link drainEvents} returned. */
  ackDrain(options: { ids: string[]; relay?: string }): Promise<void>;
  /** Drain and clear "Mark read" taps: room key + unix-seconds read-up-to. Empty on web/iOS. */
  drainReadMarkers(): Promise<{
    markers: Array<{ room: string; ts: number }>;
  }>;
  /**
   * The ring the service posted for `callId`, or `{}`. This is the authorization
   * to join from a notification: a URL proves nothing, while the service only
   * rings fresh offers from followed peers with valid secrets and https brokers.
   * Consumed once.
   */
  consumeCallAnswer(options: { callId: string }): Promise<{
    peer?: string;
    secret?: string;
    broker?: string;
  }>;
  /**
   * Peer the WebView is dialing or in a call with; the service won't ring or post
   * "Missed call" for their offers. Volatile, like {@link setActiveRooms}.
   */
  setCallPeer(options: { peer?: string }): Promise<void>;
  /**
   * The service's rolling per-room cache of raw wire events (newest last), kept
   * for the service lifetime. Room keys: `h:<groupId>`, `c2:<channelId>`, `dm`.
   */
  getRoomEvents(options: { room: string }): Promise<{ events: string[] }>;
  /**
   * NIP-42 AUTH challenge: JS signs the user's 22242 when `user` (the service
   * has no signer credential) and Concord stream auths when `streams` (the
   * relay walled the Concord sub).
   */
  addListener(
    eventName: "authChallenge",
    listener: (data: { relayUrl: string; challenge: string; user?: boolean; streams?: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  /**
   * A raw outer event the service received while the WebView is up, for
   * immediate store ingest. `relay` files group events under the right server.
   */
  addListener(
    eventName: "relayEvent",
    listener: (data: { event: string; relay?: string }) => void,
  ): Promise<PluginListenerHandle>;
  /**
   * Rooms the WebView is showing, so the service skips redundant notifications
   * (mentions still notify). Empty when backgrounded. Volatile.
   * Keys must match the service's: `h:<relayUrl>|<groupId>`, `c2:<channelIdHex>`, `dm:<peerPubkey>`.
   */
  setActiveRooms(options: { roomKeys: string[] }): Promise<void>;
  /**
   * Cancel tray notifications now covered by read state. Markers: key
   * (`dm:<pk>` / `c2:<id>` / `<relayUrl>::<groupId>`) + last-read unix seconds.
   */
  dismissRead(options: { markers: Array<{ room: string; ts: number }> }): Promise<void>;
  /** Configure and start/stop the service; `enabled: false` or no pubkey/relays stops it and clears config. */
  configure(options: {
    enabled: boolean;
    userPubkey?: string;
    /**
     * Per-plane authority: `false` merges into last-good same-account data, `true`
     * replaces (even with empty). New accounts never inherit. Omitted = `true`.
     */
    groupPlaneReady?: boolean;
    dmRelayPlaneReady?: boolean;
    dmRosterPlaneReady?: boolean;
    concordPlaneReady?: boolean;
    gitPlaneReady?: boolean;
    /** The account's synced or proven local-last-good notification settings. */
    policyPlaneReady?: boolean;
    /** Left communities, dropped even from unready (merging) planes. */
    concordLeftCommunities?: string[];
    /** Relay websocket URLs to hold open. */
    relayUrls?: string[];
    /** Joined group ids (`h` values). */
    groupIds?: string[];
    /**
     * Joined NIP-29 groups with their host relay, so each relay's REQ covers only
     * its groups. `mentionOnly` is here because an `h` id is only unique per relay.
     * `groupIds` is still sent for older native binaries.
     */
    groupSubs?: Array<{ relay: string; id: string; mentionOnly?: boolean }>;
    /** Legacy flat counterpart of `groupSubs[].mentionOnly`, used only without `groupSubs`. */
    mentionOnlyGroupIds?: string[];
    /** Relays to read kind-4 DMs from (app/DM relays, not group relays). */
    dmRelays?: string[];
    /** Legacy-DM authors (hex); scopes the kind-4 subscription, empty = none. */
    dmFollows?: string[];
    /**
     * Established 1:1 DM peers (hex), part of the NIP-17 post-decrypt request
     * boundary. Older binaries ignore it and notify everything.
     */
    dmKnownPeers?: string[];
    /** Exact NIP-17 conversation keys pinned/authored; a group key trusts only that participant set. */
    dmKnownConversations?: string[];
    dmLevels?: Record<string, "all" | "mentions" | "nothing">;
    /** Muted pubkeys; a NIP-17 notification is suppressed if any participant is muted. */
    dmMutedPeers?: string[];
    /** Unknown-conversation mode: `"off"`, `"generic"` (default), or `"full"`. */
    dmRequests?: string;
    /**
     * Relays with the user's own replaceable docs (app relays + NIP-65 reads). The
     * service mirrors self-state (follows, mutes, 10009, vaults, NIP-78 settings)
     * into the `main` tenant. Distinct from `relayUrls` (NIP-29 servers).
     */
    selfRelays?: string[];
    /**
     * `d` tags of Armada's NIP-78 docs (kind 30078 is shared across clients).
     * Sent rather than hardcoded since forks can change `VITE_APP_ID`. Absent =
     * built-in defaults, never "none".
     */
    selfDTags?: string[];
    /** Per-type notification prefs (mentions/reactions/replies/directMessages/allGroupMessages). */
    prefs?: Record<string, boolean>;
    /**
     * Media policy, so the service fetches avatars/icons like the WebView would.
     * Gated on `policyPlaneReady`. Missing = default policy.
     */
    mediaPolicy?: MediaPolicyConfig;
    /**
     * Concord (CORD-02) subscriptions: kind 1059 by stream pk, opened with the
     * per-stream NIP-44 conversation key. Stream SECRET keys never cross the bridge;
     * quick replies use the stream key from the persisted `c2gkmemo`.
     */
    concordSubs?: Array<{
      relays: string[];
      communityId: string;
      communityName: string;
      channelId: string;
      channelName: string;
      streams: Array<{ pk: string; convKey: string; epoch: string }>;
      /** Encrypted CORD-02 §6 icon pointer ({@link CommunityNotifImage}); omitted without an icon. */
      communityImage?: CommunityNotifImage;
      /** "mentions only" — suppress non-mention messages (older binaries notify all). */
      mentionOnly?: boolean;
      /** CORD-08 disappearing timer (seconds; 0/absent = off), stamped as NIP-40 on quick replies. */
      timerSecs?: number;
    }>;
    /**
     * Signer credential so the service can open gift wraps and answer NIP-42 with
     * the app dead. Sealed with an Android Keystore key; wiped on disable/logout.
     * nsec: raw key (hex). amber: NIP-55 package name. nip46: client key, bunker
     * pubkey and relays (identity key stays in the bunker).
     */
    signer?:
      | { type: "key"; sk: string }
      | { type: "amber"; packageName: string }
      | { type: "nip46"; clientSk: string; bunkerPk: string; relays: string[] };
    /** Public NIP-34 activity on Concord channels; the channel mapping stays on-device. */
    gitSubs?: Array<{
      address: string;
      relays: string[];
      owner: string;
      maintainers?: string[];
      attachments: Array<{ communityId: string; channelId: string; attachedAt: number; detachedAt?: number }>;
      ticketRoots: Array<{ id: string; author: string; kind: 1618 | 1621 }>;
    }>;
  }): Promise<void>;
}

export const ArmadaNotification =
  registerPlugin<ArmadaNotificationPlugin>("ArmadaNotification");

/** Battery-optimization exemption; `true` off Android or on older binaries (no false warnings). */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") return true;
  try {
    const { ignoring } = await ArmadaNotification.isIgnoringBatteryOptimizations();
    return ignoring;
  } catch {
    return true;
  }
}

/** The parameters of a ring the background service posted, for an Answer tap. */
export interface NativeCallAnswer {
  /** The peer the SERVICE verified the offer came from — not the URL's. */
  peer: string;
  secretHex: string;
  broker: string;
}

/**
 * Claim the ring parameters for `callId`, or null. Android-gated (not
 * `isNativePlatform()`); older APKs answer "no ticket".
 */
export async function consumeNativeCallAnswer(callId: string): Promise<NativeCallAnswer | null> {
  if (Capacitor.getPlatform() !== "android") return null;
  if (!Capacitor.isPluginAvailable("ArmadaNotification")) return null;
  try {
    const { peer, secret, broker } = await ArmadaNotification.consumeCallAnswer({ callId });
    if (!peer || !secret || !broker) return null;
    return { peer, secretHex: secret, broker };
  } catch {
    return null;
  }
}

/** Report the DM call peer (see `setCallPeer`). Android only, best-effort. */
export function setNativeCallPeer(peer: string | null): void {
  if (Capacitor.getPlatform() !== "android") return;
  if (!Capacitor.isPluginAvailable("ArmadaNotification")) return;
  ArmadaNotification.setCallPeer({ peer: peer ?? "" }).catch(() => undefined);
}

/** Open the battery-optimization exemption dialog. No-op outside Android. */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return;
  try {
    await ArmadaNotification.requestIgnoreBatteryOptimizations();
  } catch (err) {
    console.warn("[native-notif] Failed to request battery optimization exemption:", err);
  }
}

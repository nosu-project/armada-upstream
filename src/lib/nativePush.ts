import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Native bridge to `ArmadaPushPlugin.swift` — the iOS app's APNs registration.
 *
 * iOS is the one platform with no way to run Armada's own relay listener in the
 * background: there is no equivalent of the Android foreground service, and
 * WKWebView has no Web Push. The remaining route is Apple's, so the app takes
 * an APNs device token and hands it to the SAME content-blind nostr-push
 * gateway the web client uses, as a `type: "apns"` subscription. Everything
 * above the transport — the RPC, the filters, the per-channel levels, the quota
 * — is shared code (`useIosPush.ts`).
 *
 * There is no Android implementation and there will not be one: the APK ships
 * no Google Play Services, so it has no FCM to receive on, and its background
 * service is strictly better than push anyway (it holds the relay sockets
 * itself and never involves a third party).
 */

/** Whether the OS has been asked, and what it said. */
export type NativePushPermission = "granted" | "denied" | "default";

/** What `register()` returns once APNs has minted (or refused) a token. */
export interface NativePushRegistration {
  /** Whether the user granted the notification authorization prompt. */
  granted: boolean;
  /** The APNs device token, lowercase hex. Absent when not granted / failed. */
  token?: string;
  /** The app's bundle id, which becomes the gateway's `apns-topic`. */
  bundleId?: string;
  /**
   * Which APNs host minted this token, read from the build's own
   * `aps-environment` entitlement. A token is valid on exactly one host, so
   * this must travel with it.
   */
  environment?: "sandbox" | "production";
  /** Why no token, when `granted` is true but APNs still refused. */
  error?: string;
}

/** A notification tap, as an in-app router path. */
export interface NativePushOpen {
  path?: string;
}

export interface ArmadaPushPlugin {
  /** The current authorization status, without prompting. */
  permission(): Promise<{ status: NativePushPermission }>;
  /**
   * Prompt for notification authorization (a no-op after the first time — iOS
   * shows its system prompt exactly once per install) and register with APNs.
   *
   * Unlike Web Push's `PushManager.subscribe()` this need not run inside the
   * user's tap: UNUserNotificationCenter has no transient-activation rule.
   */
  register(): Promise<NativePushRegistration>;
  /** Unregister from APNs, invalidating the device token. */
  unregister(): Promise<void>;
  /** Clear the app icon badge and any delivered notifications. */
  clearBadge(): Promise<void>;
  /**
   * Hand the Notification Service Extension what it needs to open an inlined
   * event. `config` is JSON — see `IosPushConfig`.
   */
  writeConfig(options: { config: string }): Promise<void>;
  /** Delete that config, on disable or logout. */
  clearConfig(): Promise<void>;
  /**
   * Record how the last gateway registration went, on disk in the app's own
   * container, for a developer with the device on a cable.
   *
   * Registration is otherwise unobservable: the gateway answers over Nostr,
   * the answer is swallowed by a retry loop, and a device that has silently
   * stopped receiving looks exactly like one that never tried. `line` is a
   * STATUS — counts, environment, a token suffix, an error message — and must
   * never carry a token or a key.
   */
  recordStatus(options: { line: string }): Promise<void>;
  /**
   * The notification tap that launched this process, consumed once.
   *
   * A cold launch delivers the tap before the WebView has loaded, let alone
   * attached a listener, so the plugin buffers it and the app collects it at
   * startup. Resolves `{}` for an ordinary launch.
   */
  takePendingOpen(): Promise<NativePushOpen>;
  /** A notification tapped while the app was already running. */
  addListener(
    eventName: "pushOpened",
    listener: (data: NativePushOpen) => void,
  ): Promise<PluginListenerHandle>;
}

export const ArmadaPush = registerPlugin<ArmadaPushPlugin>("ArmadaPush");

/**
 * What the Notification Service Extension needs to OPEN an event the gateway
 * inlined. The iOS counterpart of `SwPushConfig`, and deliberately the same
 * shape: one set of fields, two readers.
 *
 * Like that one it carries NO display data — the extension reads names and
 * room titles out of ArmadaDB at push time, for any author, rather than from a
 * snapshot the page had to seal ahead of time and re-seal when a profile landed
 * late.
 *
 * `sk` is present ONLY for nsec logins. A bunker (NIP-46) login sends `nip46`
 * instead and the extension asks the bunker to decrypt — the client key it
 * carries addresses the bunker and nothing else, so it is a materially smaller
 * secret than an account key. Extension (NIP-07) logins send neither and stay
 * the generic wake-up: there is no browser for the extension to ask.
 */
export interface IosPushConfig {
  policy: string;
  self: string;
  knownPeers: string[];
  sk?: string;
  nip46?: { clientSk: string; bunkerPubkey: string; relays: string[] };
  concord?: Array<{
    pk: string;
    convKey: string;
    epoch: string;
    communityId: string;
    channelId: string;
  }>;
}

/** Write (replace) the extension's config. No-op where the plugin is absent. */
export async function writeIosPushConfig(config: IosPushConfig): Promise<void> {
  if (!hasIosPush()) return;
  await ArmadaPush.writeConfig({ config: JSON.stringify(config) });
}

/** Delete it. Called on disable and logout, so no key outlives its session. */
export async function clearIosPushConfig(): Promise<void> {
  if (!hasIosPush()) return;
  await ArmadaPush.clearConfig().catch(() => {});
}

/**
 * Leave a one-line record of how the last gateway registration went.
 *
 * Best-effort and never throws: this is instrumentation, and a diagnostic that
 * could fail the operation it describes would be worse than none. Keep secrets
 * out of `line` — it is a status, not a payload.
 */
export async function recordPushStatus(line: string): Promise<void> {
  if (!hasIosPush()) return;
  await ArmadaPush.recordStatus({ line }).catch(() => {});
}

/**
 * Whether this build can take an APNs token.
 *
 * Gated on the platform being iOS *and* the plugin actually being present, not
 * on `isNativePlatform()`: Android is native too, and would otherwise reach a
 * `registerPlugin` proxy with nothing behind it, where every call can only
 * reject. The `isPluginAvailable` half additionally covers an iOS build made
 * before this plugin existed.
 */
export function hasIosPush(): boolean {
  return Capacitor.getPlatform() === "ios" && Capacitor.isPluginAvailable("ArmadaPush");
}

/**
 * The notification tap that launched this process, as a router path.
 *
 * Read once at startup by `coldLaunchDeepLink`, alongside the launch URL: a
 * push tap does NOT produce one (it is delivered to the notification delegate,
 * not as a URL open), so it is a second, equally cold source of the same
 * answer. Resolves null where there is no plugin to ask.
 */
export async function takePendingPushOpen(): Promise<string | null> {
  if (!hasIosPush()) return null;
  const { path } = await ArmadaPush.takePendingOpen();
  return path && path.startsWith("/") ? path : null;
}

/** Per-install id, so two devices don't take turns owning one gateway record. */
const INSTALL_KEY = "armada:push-install";

/**
 * A stable id for THIS install of the app.
 *
 * nostr-push indexes `subscription_id` globally and registering is replace, so
 * the id has to name the install as well as the account
 * (`scopePushSubscriptionId`). The native builds share `armada.buzz` as their
 * `domain` with the hosted web client — they have no origin of their own worth
 * naming — so without this an iPhone and a browser signed into one account
 * would overwrite each other's registrations on every sync.
 *
 * Random and local: it identifies a subscription record, and is never sent
 * anywhere but inside the NIP-44 encrypted RPC. If storage is unavailable the
 * fallback is a fresh id per session, which merely leaks stale gateway records
 * rather than breaking delivery — better than silently sharing one.
 */
export function pushInstallationId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY);
    if (existing) return existing;
  } catch {
    // Private mode / storage disabled — fall through to a fresh id.
  }
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(INSTALL_KEY, id);
  } catch {
    // ignore
  }
  return id;
}

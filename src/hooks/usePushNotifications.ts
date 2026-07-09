import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutes } from "@/hooks/useMutes";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import { normalizeRelayUrl, PLATFORM_RELAYS, relayToHttpUrl } from "@/lib/platform";

import type { NostrSigner } from "@nostrify/types";

/**
 * usePushNotifications
 *
 * Web Push lifecycle against the Armada relay's push gateway
 * (`/.well-known/armada/push`). The relay observes every message it stores and
 * sends a VAPID Web Push to each subscribed recipient, so members get notified
 * with the app closed — no external push service.
 *
 * Flow:
 *   1. Register the service worker (done in main.tsx).
 *   2. enable(): request Notification permission, fetch the relay's VAPID
 *      public key, `pushManager.subscribe()`, then PUT the subscription +
 *      preferences to the relay (NIP-98 signed).
 *   3. disable(): unsubscribe the browser and DELETE the server record.
 */

/** NIP-98 HTTP Auth event kind. */
const KIND_HTTP_AUTH = 27235;

/** localStorage key for the user's notification preferences. */
const PREFS_KEY = "armada:push-prefs";
/**
 * localStorage key for the user's push INTENT (the master on/off wish),
 * separate from the per-type prefs. Defaults to on: push is opt-out. The
 * browser still requires a user gesture to grant Notification permission the
 * first time, but once granted we keep push enabled automatically.
 */
const INTENT_KEY = "armada:push-intent";

function loadIntent(): boolean {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    if (raw === null) return true; // on by default
    return raw === "true";
  } catch {
    return true;
  }
}

function saveIntent(on: boolean): void {
  try {
    localStorage.setItem(INTENT_KEY, String(on));
  } catch {
    // ignore
  }
}

/** Discord-style per-type notification preferences. */
export interface PushPrefs {
  /** Messages that mention you (p-tag). Default on. */
  mentions: boolean;
  /** Reactions to your messages. Default on. */
  reactions: boolean;
  /** Replies to your messages. Default on. */
  replies: boolean;
  /** Direct messages. Default on. */
  directMessages: boolean;
  /** Every message in your groups (not just mentions). Default on. */
  allGroupMessages: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  mentions: true,
  reactions: true,
  replies: true,
  directMessages: true,
  allGroupMessages: true,
};

function loadPrefs(): PushPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_PUSH_PREFS };
}

function savePrefs(prefs: PushPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

/** The push gateway lives on the platform relay's HTTP origin. */
function pushBaseUrl(): string | undefined {
  const relay = PLATFORM_RELAYS[0];
  if (!relay) return undefined;
  return `${relayToHttpUrl(relay)}/.well-known/armada/push`;
}

/** base64url (VAPID public key) → ArrayBuffer for applicationServerKey. */
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/** Sign a NIP-98 Authorization header value for a request to `url`. */
async function nip98Auth(signer: NostrSigner, url: string, method: string): Promise<string> {
  const event = await signer.signEvent({
    kind: KIND_HTTP_AUTH,
    content: "",
    tags: [
      ["u", url],
      ["method", method],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

export interface UsePushNotificationsReturn {
  /** Whether this browser/environment supports Web Push against a configured relay. */
  supported: boolean;
  /** Current Notification permission. */
  permission: NotificationPermission;
  /** Whether push is currently active (subscribed + registered). */
  enabled: boolean;
  /** Whether an enable/disable/sync operation is in flight. */
  busy: boolean;
  /** Current notification preferences. */
  prefs: PushPrefs;
  /** Request permission, subscribe, and register with the relay. */
  enable: () => Promise<void>;
  /** Unsubscribe and delete the server record. */
  disable: () => Promise<void>;
  /** Update preferences; re-syncs the server record when enabled. */
  setPrefs: (next: PushPrefs) => Promise<void>;
}

export function usePushNotifications(): UsePushNotificationsReturn {
  const { user } = useCurrentUser();
  // useNostr is referenced to keep the hook within the Nostr provider tree even
  // though publishing here goes over plain fetch (NIP-98), not the pool.
  useNostr();
  const { data: groupList } = useUserGroupList();
  const { mutedChannels, isCommunityMuted } = useMutes();

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    Boolean(pushBaseUrl());

  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPrefs);

  const swRef = useRef<ServiceWorkerRegistration | null>(null);

  // Group ids on the platform relay (the push gateway) the user has muted —
  // individually, or via a whole-server mute. Sent with the registration so
  // the relay's fan-out skips them (it pushes to group *members*; only it can
  // enforce a mute with the app closed).
  const mutedGroups = useMemo(() => {
    const platform = PLATFORM_RELAYS[0] ? normalizeRelayUrl(PLATFORM_RELAYS[0]) : undefined;
    if (!platform) return [];
    const out = new Set<string>();
    // Explicit channel mutes on the platform relay, parsed from their
    // `${relayUrl}::${groupId}` keys (Concord `c1:`/`c2:` keys never
    // normalize to a relay URL, so they fall out here).
    for (const key of mutedChannels) {
      const idx = key.lastIndexOf("::");
      if (idx < 0) continue;
      if (normalizeRelayUrl(key.slice(0, idx)) !== platform) continue;
      const groupId = key.slice(idx + 2);
      if (groupId) out.add(groupId);
    }
    // A muted server mutes every joined group on it.
    if (isCommunityMuted(platform)) {
      for (const g of groupList?.groups ?? []) {
        if (normalizeRelayUrl(g.relay) === platform) out.add(g.id);
      }
    }
    return [...out].sort();
  }, [mutedChannels, isCommunityMuted, groupList]);

  // Restore enabled state on mount: if permission is granted and a browser push
  // subscription already exists, we're enabled.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (cancelled) return;
        swRef.current = reg;
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (existing && Notification.permission === "granted") {
          setEnabled(true);
        }
      } catch {
        // SW not ready / unsupported — leave disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  /** PUT the subscription + prefs + mutes to the relay (NIP-98 authed). */
  const register = useCallback(
    async (subscription: PushSubscription, p: PushPrefs) => {
      if (!user) throw new Error("Not logged in");
      const base = pushBaseUrl();
      if (!base) throw new Error("Push gateway not configured");

      const auth = await nip98Auth(user.signer, base, "PUT");
      const res = await fetch(base, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          prefs: {
            mentions: p.mentions,
            reactions: p.reactions,
            replies: p.replies,
            direct_messages: p.directMessages,
            all_group_messages: p.allGroupMessages,
            muted_groups: mutedGroups,
          },
        }),
      });
      if (!res.ok) throw new Error(`Push registration failed: HTTP ${res.status}`);
    },
    [user, mutedGroups],
  );

  const enable = useCallback(async () => {
    if (!supported || !user) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;

      const reg = swRef.current ?? (await navigator.serviceWorker.ready);
      swRef.current = reg;

      // Fetch the relay's VAPID public key.
      const base = pushBaseUrl()!;
      const vapidRes = await fetch(`${base}/vapid`);
      if (!vapidRes.ok) throw new Error(`VAPID key fetch failed: HTTP ${vapidRes.status}`);
      const { vapid_public_key: vapidPublicKey } = await vapidRes.json();
      if (!vapidPublicKey) throw new Error("Relay did not return a VAPID key");

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(vapidPublicKey),
        });
      }

      await register(sub, prefs);
      saveIntent(true);
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }, [supported, user, prefs, register]);

  // Auto-enable: push is on by default (opt-out). When the user intends push,
  // permission is already granted, and they're logged in, subscribe + register
  // silently — no user gesture needed because permission already exists. (A
  // brand-new user with permission "default" still has to click once to grant;
  // we can't prompt without a gesture. Their intent stays on, so once granted
  // it sticks across reloads and devices.)
  const autoTried = useRef(false);
  useEffect(() => {
    if (!supported || !user) return;
    if (enabled || busy || autoTried.current) return;
    if (Notification.permission !== "granted") return;
    if (!loadIntent()) return;
    autoTried.current = true;
    enable();
  }, [supported, user, enabled, busy, enable]);

  // Re-sync the server record whenever the muted-group set changes while push
  // is active, so a mute/unmute reaches the gateway immediately (it enforces
  // mutes at fan-out — the only place that can, with the app closed). Guarded
  // so the same set is never re-PUT.
  const mutedKey = mutedGroups.join(",");
  const lastSyncedMutes = useRef<string | null>(null);
  useEffect(() => {
    if (!supported || !enabled || !user) return;
    if (lastSyncedMutes.current === mutedKey) return;
    lastSyncedMutes.current = mutedKey;
    (async () => {
      const reg = swRef.current ?? (await navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();
      if (sub) await register(sub, prefs);
    })().catch((err) => {
      // Retry on the next change (or re-mount).
      lastSyncedMutes.current = null;
      console.warn("[push] failed to sync mutes:", err);
    });
  }, [supported, enabled, user, mutedKey, prefs, register]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = swRef.current ?? (await navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();

      // Delete the server record first (needs the endpoint + a fresh NIP-98).
      if (sub && user) {
        const base = pushBaseUrl();
        if (base) {
          try {
            const auth = await nip98Auth(user.signer, base, "DELETE");
            await fetch(base, {
              method: "DELETE",
              headers: { Authorization: auth, "Content-Type": "application/json" },
              body: JSON.stringify({ subscription: sub.toJSON() }),
            });
          } catch (err) {
            console.warn("[push] failed to delete server record:", err);
          }
        }
      }

      if (sub) {
        try {
          await sub.unsubscribe();
        } catch {
          // ignore
        }
      }
      saveIntent(false);
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }, [user]);

  const setPrefs = useCallback(
    async (next: PushPrefs) => {
      setPrefsState(next);
      savePrefs(next);
      // Re-sync the server record if we're active.
      if (enabled && user) {
        const reg = swRef.current ?? (await navigator.serviceWorker.ready);
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          try {
            await register(sub, next);
          } catch (err) {
            console.warn("[push] failed to sync preferences:", err);
          }
        }
      }
    },
    [enabled, user, register],
  );

  return { supported, permission, enabled, busy, prefs, enable, disable, setPrefs };
}

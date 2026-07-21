import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNotifLevels } from "@/hooks/useNotifLevels";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import {
  normalizeRelayUrl,
  nostrPushConfigured,
  PLATFORM_RELAYS,
  relayToHttpUrl,
} from "@/lib/platform";

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
 *   2. enable(): request Notification permission, then syncSubscription() —
 *      fetch the relay's VAPID public key, `pushManager.subscribe()`, and PUT
 *      the subscription + preferences to the relay (NIP-98 signed).
 *   3. On every load (and whenever the SW reports a rotated subscription),
 *      re-run syncSubscription() silently. The PUT is idempotent; without the
 *      deterministic re-register, a relay that lost/pruned the record, a
 *      rotated VAPID key, or a browser-rotated push endpoint each kill push
 *      silently until the user toggles it by hand.
 *   4. disable(): unsubscribe the browser and DELETE the server record.
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

/**
 * Whether an existing subscription was created against `vapidKey`. A
 * subscription made under an old key can't receive pushes signed with the
 * current one. Browsers that don't expose `options.applicationServerKey`
 * can't be checked — treat those as matching rather than churn the
 * subscription on every load.
 */
function matchesServerKey(sub: PushSubscription, vapidKey: ArrayBuffer): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  const b = new Uint8Array(vapidKey);
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
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

  const supported =
    // When a content-blind nostr-push gateway is configured, that path owns
    // web push (see useNostrPush); this legacy relay-gateway path stands down
    // so the two don't both subscribe/register against different VAPID keys.
    !nostrPushConfigured() &&
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

  // Per-group notification levels on the platform relay (the push gateway),
  // sent with the registration so the relay's fan-out can enforce them with the
  // app closed (it pushes to group *members* — only it can, with no client
  // running). `nothing` groups are skipped entirely; `mentions` groups get only
  // messages that p-tag the recipient.
  const { channelLevel } = useNotifLevels();
  const { mutedGroups, mentionOnlyGroups } = useMemo(() => {
    const platform = PLATFORM_RELAYS[0] ? normalizeRelayUrl(PLATFORM_RELAYS[0]) : undefined;
    if (!platform) return { mutedGroups: [] as string[], mentionOnlyGroups: [] as string[] };
    const muted = new Set<string>();
    const mentionOnly = new Set<string>();
    for (const g of groupList?.groups ?? []) {
      if (normalizeRelayUrl(g.relay) !== platform) continue;
      const level = channelLevel(g.relay, g.id);
      if (level === "nothing") muted.add(g.id);
      else if (level === "mentions") mentionOnly.add(g.id);
    }
    return { mutedGroups: [...muted].sort(), mentionOnlyGroups: [...mentionOnly].sort() };
  }, [channelLevel, groupList]);

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

  /** PUT the subscription + prefs + per-group levels to the relay (NIP-98 authed). */
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
            // Groups the user set to "mentions only": the gateway should push a
            // message in these only when it p-tags the recipient. Older
            // gateways that ignore this field simply push all (graceful).
            mention_only_groups: mentionOnlyGroups,
          },
        }),
      });
      if (!res.ok) throw new Error(`Push registration failed: HTTP ${res.status}`);
    },
    [user, mutedGroups, mentionOnlyGroups],
  );

  /**
   * Make the browser subscription real and current, then PUT it to the relay:
   * fetch the relay's VAPID key, drop a subscription made against a stale key,
   * subscribe if none exists, and (re-)register the result. Idempotent — safe
   * to run on every load.
   */
  const syncSubscription = useCallback(
    async (p: PushPrefs) => {
      const reg = swRef.current ?? (await navigator.serviceWorker.ready);
      swRef.current = reg;

      const base = pushBaseUrl()!;
      const vapidRes = await fetch(`${base}/vapid`);
      if (!vapidRes.ok) throw new Error(`VAPID key fetch failed: HTTP ${vapidRes.status}`);
      const { vapid_public_key: vapidPublicKey } = await vapidRes.json();
      if (!vapidPublicKey) throw new Error("Relay did not return a VAPID key");
      const key = urlBase64ToBuffer(vapidPublicKey);

      let sub = await reg.pushManager.getSubscription();
      if (sub && !matchesServerKey(sub, key)) {
        // The relay's VAPID key rotated since this subscription was made:
        // pushes signed with the current key would be rejected by the push
        // service. Start over.
        try {
          await sub.unsubscribe();
        } catch {
          // ignore — subscribe() below surfaces a real failure
        }
        sub = null;
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
      }

      await register(sub, p);
    },
    [register],
  );

  /** Pubkey whose server record was synced this session (skip re-PUTs). */
  const syncedFor = useRef<string | null>(null);

  const enable = useCallback(async () => {
    if (!supported || !user) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;

      await syncSubscription(prefs);
      saveIntent(true);
      syncedFor.current = user.pubkey;
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }, [supported, user, prefs, syncSubscription]);

  // Auto-(re)sync: push is on by default (opt-out). Whenever the user intends
  // push, permission is already granted, and they're logged in, silently
  // ensure a current browser subscription exists and re-PUT it to the relay —
  // on every load, not just the first enable. The relay may have pruned the
  // server record (stale endpoint, data loss) and the browser may have rotated
  // the subscription (see the SW's pushsubscriptionchange handler); without a
  // deterministic re-register, either kills push silently until the user
  // toggles it by hand. Transient failures retry with backoff, then give up
  // until the next load. (A brand-new user with permission "default" still has
  // to click once to grant — we can't prompt without a gesture. Their intent
  // stays on, so once granted it sticks across reloads.)
  const retryCount = useRef(0);
  const [syncNonce, setSyncNonce] = useState(0);
  useEffect(() => {
    if (!supported || !user) return;
    if (Notification.permission !== "granted") return;
    if (!loadIntent()) return;
    if (syncedFor.current === user.pubkey) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        await syncSubscription(prefs);
        if (cancelled) return;
        syncedFor.current = user.pubkey;
        retryCount.current = 0;
        setEnabled(true);
      } catch (err) {
        if (cancelled) return;
        console.warn("[push] subscription sync failed:", err);
        if (retryCount.current < 3) {
          const delay = 10_000 * 2 ** retryCount.current;
          retryCount.current += 1;
          retryTimer = setTimeout(() => setSyncNonce((n) => n + 1), delay);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [supported, user, syncNonce, prefs, syncSubscription]);

  // The SW posts armada-push-changed when the browser rotated the push
  // subscription (pushsubscriptionchange): the new subscription must be
  // re-registered with the relay or pushes keep going to the dead endpoint,
  // and only the page can do that (the PUT needs a NIP-98 signature).
  useEffect(() => {
    if (!supported) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "armada-push-changed") return;
      syncedFor.current = null;
      retryCount.current = 0;
      setSyncNonce((n) => n + 1);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [supported]);

  // Re-sync the server record whenever the per-group level sets change while
  // push is active, so a level change reaches the gateway immediately (it
  // enforces levels at fan-out — the only place that can, with the app closed).
  // Guarded so the same sets are never re-PUT.
  const levelKey = `${mutedGroups.join(",")}|${mentionOnlyGroups.join(",")}`;
  const lastSyncedLevels = useRef<string | null>(null);
  useEffect(() => {
    if (!supported || !enabled || !user) return;
    if (lastSyncedLevels.current === levelKey) return;
    lastSyncedLevels.current = levelKey;
    (async () => {
      const reg = swRef.current ?? (await navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();
      if (sub) await register(sub, prefs);
    })().catch((err) => {
      // Retry on the next change (or re-mount).
      lastSyncedLevels.current = null;
      console.warn("[push] failed to sync notification levels:", err);
    });
  }, [supported, enabled, user, levelKey, prefs, register]);

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
      syncedFor.current = null;
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

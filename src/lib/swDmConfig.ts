/**
 * Hands the Web Push service worker the small amount of state it needs to gate
 * DM notifications from an inlined gift wrap: the request policy, the known-peer
 * set, the user's own pubkey, and — for local nsec logins only — the secret key
 * that unseals the wrap.
 *
 * A service worker can't read localStorage or the app's IndexedDB, so this
 * writes into the same Cache Storage the worker already reads (`sw.js`'s
 * PUSH_STATE_CACHE). The worker reads it synchronously per push; a stale or
 * missing entry just degrades DM push to the generic wake-up, which is safe.
 *
 * SECURITY: `sk` persists the raw identity key where the service worker (a
 * background context) can read it — same-origin Cache Storage, no worse at rest
 * than the localStorage the nsec already lives in, but readable while the app is
 * closed. It is written ONLY for nsec logins and ONLY while web push is enabled,
 * and is wiped by {@link clearSwDmConfig} on disable/logout. Bunker (NIP-46) and
 * extension (NIP-07) logins never pass a key — their DMs simply can't be
 * decrypted in the worker, and web push stays generic for them.
 */

import type { DmRequestLevel } from "@/lib/pushPrefs";

/** Must match `PUSH_STATE_CACHE` / the dm-config URL in `public/sw.js`. */
const PUSH_STATE_CACHE = "armada-push-state-v1";
const DM_CONFIG_PATH = "/.armada-push-state/dm-config";

export interface SwDmConfig {
  /** How to notify for DMs from unknown senders. */
  policy: DmRequestLevel;
  /** The viewer's own pubkey (hex) — to drop self-sent copies. */
  self: string;
  /** follows ∪ accepted ∪ pinned (hex) — the "known" senders. */
  knownPeers: string[];
  /** Decrypt key (hex). Present for nsec logins only. */
  sk?: string;
}

function dmConfigUrl(): string {
  return new URL(DM_CONFIG_PATH, location.origin).href;
}

/** Write (replace) the worker's DM gating config. No-op where Cache is absent. */
export async function writeSwDmConfig(config: SwDmConfig): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(
      dmConfigUrl(),
      new Response(JSON.stringify(config), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    // Cache Storage unavailable (private mode / unsupported) — the worker falls
    // back to the generic wake-up.
  }
}

/** Remove the config (and the key it carries). Called on disable/logout. */
export async function clearSwDmConfig(): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.delete(dmConfigUrl());
  } catch {
    // ignore
  }
}

/**
 * Hands the Web Push service worker the small amount of state it needs to gate
 * DM notifications from an inlined gift wrap: the request policy, the known-peer
 * set, the user's own pubkey, and — for local nsec logins only — the secret key
 * that unseals the wrap.
 *
 * A service worker can't read localStorage or the app's IndexedDB, so this
 * writes into the same Cache Storage the worker already reads (`sw.js`'s
 * PUSH_STATE_CACHE). The worker opens it per push; a stale or missing entry just
 * degrades DM push to the generic wake-up, which is safe.
 *
 * SECURITY: the config (whose `sk` field is the identity key that unseals gift
 * wraps) is AES-GCM sealed at rest under a NON-EXTRACTABLE WebCrypto key
 * (swSecretVault), not written in the clear — so it never adds a second
 * plaintext copy of the nsec to disk, and a stolen profile/backup yields
 * ciphertext plus a key JS can't export. `sk` is present ONLY for nsec logins
 * and ONLY while web push is enabled, and both the blob and its key are wiped by
 * {@link clearSwDmConfig} on disable/logout. Bunker (NIP-46) / extension
 * (NIP-07) logins never pass a key — their DMs can't be decrypted in the worker
 * and web push stays generic for them. This does NOT defend against XSS (same
 * hazard as the localStorage nsec); hardware isolation exists only on native.
 */

import type { DmRequestLevel } from "@/lib/pushPrefs";
import { clearVault, sealConfig } from "@/lib/swSecretVault";

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
  /**
   * Display names for known peers (hex → name). The worker has no profile
   * store, so notification titles resolve from this snapshot; a missing entry
   * falls back to a generic title.
   */
  peerNames?: Record<string, string>;
  /** Decrypt key (hex). Present for nsec logins only. */
  sk?: string;
}

function dmConfigUrl(): string {
  return new URL(DM_CONFIG_PATH, location.origin).href;
}

/** Write (replace) the worker's DM gating config, sealed at rest. No-op where
 * Cache/crypto is absent. */
export async function writeSwDmConfig(config: SwDmConfig): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const sealed = await sealConfig(config);
    const cache = await caches.open(PUSH_STATE_CACHE);
    // Store the raw ciphertext bytes; the worker reads them back via arrayBuffer.
    await cache.put(dmConfigUrl(), new Response(sealed));
  } catch {
    // Cache/WebCrypto unavailable (private mode / unsupported) — the worker
    // falls back to the generic wake-up.
  }
}

/** Remove the config blob AND destroy its key. Called on disable/logout. */
export async function clearSwDmConfig(): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.delete(dmConfigUrl());
  } catch {
    // ignore
  }
  // Destroy the vault key even if the Cache delete failed, so the sealed blob
  // (if any) is left permanently unreadable.
  await clearVault();
}

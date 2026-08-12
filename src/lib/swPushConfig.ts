/**
 * Hands the Web Push service worker the state it needs to OPEN an encrypted
 * event the push payload inlined: the DM request policy, the known-peer set,
 * the user's own pubkey, the identity key that unseals a NIP-17 gift wrap (nsec
 * logins only), and the per-channel Concord stream keys.
 *
 * A service worker can't read localStorage, so this writes into the same Cache
 * Storage the worker already reads (`sw.js`'s PUSH_STATE_CACHE). The worker
 * opens it per push; a stale or missing entry just degrades that scope to the
 * generic wake-up, which is safe.
 *
 * It does NOT carry display data. An earlier version sealed a name and avatar
 * per known peer, on the premise — stated here, and wrong — that a worker
 * cannot reach the app's IndexedDB. It can: ArmadaDB is IndexedDB on the web,
 * and `pushRuntime.ts` opens the same database the page does. Names, avatars,
 * community icons and channel titles are therefore READ at push time, for any
 * author rather than a pre-sealed few, and the snapshot (with the timed
 * re-seals it needed to catch profiles that landed late) is gone.
 *
 * SECURITY: the config is AES-GCM sealed at rest under a NON-EXTRACTABLE
 * WebCrypto key (swSecretVault), not written in the clear — so it never adds a
 * second plaintext copy of the nsec to disk, and a stolen profile/backup yields
 * ciphertext plus a key JS can't export. `sk` is present ONLY for nsec logins
 * and ONLY while web push is enabled, and both the blob and its key are wiped
 * by {@link clearSwPushConfig} on disable/logout. Bunker (NIP-46) / extension
 * (NIP-07) logins never pass a key — their DMs can't be decrypted in the worker
 * and web push stays generic for them.
 *
 * The Concord keys are a strictly smaller secret than the `sk` beside them, and
 * the same one the Android service already gets: a stream's NIP-44 conversation
 * key READS one channel at one epoch. The wrap-SIGNING key is deliberately not
 * here, so nothing in this blob can write to a community. Being per-epoch, the
 * set also goes stale by itself at the next rekey rather than granting
 * anything onward.
 *
 * This does NOT defend against XSS (same hazard as the localStorage nsec);
 * hardware isolation exists only on native.
 */

import type { DmRequestLevel } from "@/lib/pushPrefs";
import { clearVault, sealConfig } from "@/lib/swSecretVault";

/** Must match `PUSH_STATE_CACHE` / the config URL in `public/sw.js`. */
const PUSH_STATE_CACHE = "armada-push-state-v1";
const PUSH_CONFIG_PATH = "/.armada-push-state/dm-config";

/**
 * One Concord channel's current stream, as the worker needs it: the wrap author
 * to recognise, the key that opens it, and the binding the rumor inside must
 * match. Mirrors `ConcordStream` plus the ids the deep link and the store need.
 */
export interface SwConcordStream {
  /** Stream address (x-only pubkey hex) — equals the wrap's `pubkey`. */
  pk: string;
  /** NIP-44 conversation key (hex) that decrypts this stream's wraps. */
  convKey: string;
  /** Epoch (decimal string) the rumor's `epoch` binding tag must equal. */
  epoch: string;
  /** Community id (hex) — the deep link and the ArmadaDB tenant. */
  communityId: string;
  /** Channel id (hex) — the deep link and the rumor's `channel` binding tag. */
  channelId: string;
  /**
   * The community's banned authors (CORD-04), hex pubkeys. A banned member's
   * message is still stored — the timeline folds it away on read — but must not
   * raise a notification, so the worker drops it after decrypt. Community-wide,
   * carried per stream because that is the flat shape the config already uses.
   */
  banned?: string[];
}

export interface SwPushConfig {
  /** How to notify for DMs from unknown senders. */
  policy: DmRequestLevel;
  /** The viewer's own pubkey (hex) — to drop self-sent copies. */
  self: string;
  /** follows ∪ accepted ∪ pinned (hex) — the "known" senders. */
  knownPeers: string[];
  /** Decrypt key (hex). Present for nsec logins only. */
  sk?: string;
  /**
   * The current epoch's stream for every watched Concord channel. Only the
   * current one: a retired epoch is read-cutoff history and must not notify.
   */
  concord?: SwConcordStream[];
}

function pushConfigUrl(): string {
  return new URL(PUSH_CONFIG_PATH, location.origin).href;
}

/** Write (replace) the worker's push config, sealed at rest. No-op where
 * Cache/crypto is absent. */
export async function writeSwPushConfig(config: SwPushConfig): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const sealed = await sealConfig(config);
    const cache = await caches.open(PUSH_STATE_CACHE);
    // Store the raw ciphertext bytes; the worker reads them back via arrayBuffer.
    await cache.put(pushConfigUrl(), new Response(sealed));
  } catch {
    // Cache/WebCrypto unavailable (private mode / unsupported) — the worker
    // falls back to the generic wake-up.
  }
}

/** Remove the config blob AND destroy its key. Called on disable/logout. */
export async function clearSwPushConfig(): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.delete(pushConfigUrl());
  } catch {
    // ignore
  }
  // Destroy the vault key even if the Cache delete failed, so the sealed blob
  // (if any) is left permanently unreadable.
  await clearVault();
}

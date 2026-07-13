/**
 * Post-login Concord V2 warm-up — the work that makes a fresh device's
 * communities REAL before the SyncGate lifts (the Signal pattern: never drop
 * the user into a wall of empty rooms).
 *
 * Fetching the Community List alone (what the gate used to do) yields rail
 * icons but hollow communities: channels come from the control plane and
 * messages from per-channel backfills that previously only ran once you
 * navigated into a room. This module runs that catch-up eagerly, in order:
 *
 *   1. rehydrate each live membership entry into a runtime community;
 *   2. register the plane stream keys (NIP-42) and sweep every community's
 *      control + guestbook planes (batched per relay via planeSync);
 *   3. fold the control plane and PERSIST the fold snapshot, so channel lists
 *      and community names paint instantly when the app shows through;
 *   4. pull + decrypt the newest page of every channel into the rumor store,
 *      reporting per-channel progress to the caller (the gate's x/y line) and
 *      on the sync-activity signal (the in-chat bar takes over if the gate's
 *      time budget expires before the warm-up finishes).
 *
 * Everything is best-effort: a dead relay or an undecryptable channel skips,
 * never throws. The normal runtime paths (plane sweeps, channel backfills)
 * re-cover anything missed here — cursors only advance on their reads.
 */

import { channelsView } from "@/concord-v2/lib/community";
import { rehydrateCommunity, type CommunityListEntry } from "@/concord-v2/lib/communityList";
import { controlGroups, foldControlState, openControlEditions } from "@/concord-v2/lib/control";
import { guestbookGroups } from "@/concord-v2/lib/guestbook";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { openChatBatch } from "@/concord-v2/lib/chat";
import { sweepControl, sweepGuestbook, whenAuthSettled } from "@/concord-v2/lib/planeSync";
import { queryByStreams, writeRumors } from "@/concord-v2/lib/rumorStore";
import { registerStreamKeys } from "@/concord-v2/lib/streamAuth";
import { controlFoldKey } from "@/concord-v2/hooks/useControlPlane2";
import { writeFolded } from "@/lib/foldedCache";
import { beginSyncTask } from "@/lib/syncActivity";
import { logSync } from "@/lib/syncLog";
import { emitWireScopes } from "@/wire/bus";

import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable Nostr client the warm-up needs (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** Cap on communities warmed eagerly (mirrors the V1 gate cap). */
const MAX_WARMUP_COMMUNITIES = 6;
/** Cap on channels backfilled eagerly across all communities. */
const MAX_WARMUP_CHANNELS = 24;
/** Newest-page size per channel per relay (mirrors the channel backfill page). */
const WARMUP_PAGE = 50;
/** Per-channel network budget. */
const CHANNEL_TIMEOUT_MS = 8_000;

export interface WarmupResult {
  /** Communities rehydrated and swept. */
  communities: number;
  /** Channels whose newest page was pulled. */
  channels: number;
  /** Rumors decrypted into the store across all channels. */
  messages: number;
}

/**
 * Warm every live community for a freshly logged-in device. Reports
 * per-channel progress via `onProgress(done, total)`. Best-effort throughout;
 * respects `signal` for the channel pulls (plane sweeps share one batched REQ
 * per relay and run to completion on their own budget).
 */
export async function warmupCommunities2(
  nostr: NostrLike,
  entries: CommunityListEntry[],
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<WarmupResult> {
  const communities: CommunityV2[] = [];
  for (const entry of entries.slice(0, MAX_WARMUP_COMMUNITIES)) {
    const community = rehydrateCommunity(entry);
    if (community && community.relays.length > 0) communities.push(community);
  }
  const result: WarmupResult = { communities: communities.length, channels: 0, messages: 0 };
  if (communities.length === 0) return result;

  // Report on the sync-activity signal too: if the gate's time budget expires
  // before the warm-up finishes, the in-chat status bar carries the rest.
  const task = beginSyncTask("message history");
  try {
    // ── Plane sweeps (control + guestbook), one batched REQ per relay ───────
    // Keys must register BEFORE the sweeps so the relays' NIP-42 challenges
    // cover them (planeSync's auth gate holds the REQs until the AUTHs ack).
    for (const c of communities) {
      registerStreamKeys([...controlGroups(c), ...guestbookGroups(c)], c.relays);
    }
    await Promise.all(
      communities.flatMap((c) => [
        sweepControl(nostr, c).catch(() => []),
        sweepGuestbook(nostr, c).catch(() => []),
      ]),
    );

    // ── Fold + persist snapshots; derive readable channels ──────────────────
    const jobs: Array<{ community: CommunityV2; channel: ChannelV2 }> = [];
    for (const c of communities) {
      try {
        const stored = await queryByStreams(controlGroups(c).map((g) => g.pk));
        const folded = foldControlState(openControlEditions(stored), c.id, c.owner);
        await writeFolded(controlFoldKey(c.idHex), folded);
        emitWireScopes([`c2ctl:${c.idHex}`]);
        for (const channel of channelsView(c, folded)) {
          if (channel.streams.length === 0) continue;
          registerStreamKeys(channel.streams.map((s) => s.group), c.relays);
          jobs.push({ community: c, channel });
        }
      } catch (err) {
        logSync("gate", `warmup fold ${c.idHex.slice(0, 8)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Newest page per channel into the rumor store ────────────────────────
    const capped = jobs.slice(0, MAX_WARMUP_CHANNELS);
    result.channels = capped.length;
    let done = 0;
    opts.onProgress?.(0, capped.length);
    await Promise.all(
      capped.map(async ({ community, channel }) => {
        try {
          const groupsOf = () => channel.streams.map((s) => s.group);
          const filter: NostrFilter = {
            kinds: [KIND_WRAP],
            authors: channel.streams.map((s) => s.group.pk),
            limit: WARMUP_PAGE,
          };
          /**
           * Pull one relay's newest page, gated on NIP-42. A kind-1059 REQ
           * racing the stream AUTHs gets CLOSED and reads back as a clean
           * empty page — which made the warm-up "finish" with zero messages
           * on auth-gating relays. Hold until the relay has acked our AUTHs;
           * if the first round still comes back empty (the REQ itself may
           * have triggered a lazy challenge), wait for the acks and re-ask
           * once before believing the emptiness.
           */
          const pull = async (url: string): Promise<NostrEvent[]> => {
            for (let attempt = 1; attempt <= 2; attempt++) {
              await whenAuthSettled(url, groupsOf);
              try {
                const events = await nostr.relay(url).query([filter], {
                  signal: AbortSignal.any([
                    ...(opts.signal ? [opts.signal] : []),
                    AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
                  ]),
                });
                if (events.length > 0 || attempt === 2) return events;
              } catch {
                if (attempt === 2) return [];
              }
              await new Promise((r) => setTimeout(r, 250));
            }
            return [];
          };
          const wraps = (await Promise.all(community.relays.map(pull))).flat();
          const opened = await openChatBatch(wraps, channel);
          if (opened.length > 0) {
            // writeRumors rings `c2:<channel>` on the wire bus once committed.
            writeRumors(opened);
            result.messages += opened.length;
          }
        } catch {
          // Best-effort per channel — the room backfills on open.
        } finally {
          done++;
          opts.onProgress?.(done, capped.length);
          task.update({ detail: `${done}/${capped.length} channels` });
        }
      }),
    );
    logSync(
      "gate",
      `v2 warmup: ${result.communities} community(ies), ${result.channels} channel(s), ${result.messages} rumor(s) decrypted`,
    );
    return result;
  } finally {
    task.end();
  }
}

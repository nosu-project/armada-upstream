import { openChatBatch } from "@/concord-v2/lib/chat";
import { parkPendingWraps, writeRumors } from "@/concord-v2/lib/rumorStore";
import { emitWireScopes } from "@/wire/bus";

import type { WireSpec } from "@/wire/spec";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { NostrEvent } from "@nostrify/nostrify";

/** Gift-wrap kinds (Concord V2 / NIP-59) — never persisted sealed. */
const WRAP_KINDS = new Set([1059, 21059]);

/** The minimal store surface the wire writes to (armada-events). */
export interface WireEventStore {
  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
}

export interface WireSinks {
  /** The shared plaintext event store (armada-events IndexedDB). */
  eventStore: Promise<WireEventStore>;
  /** The current spec (decrypt map + scope naming). */
  getSpec: () => WireSpec | undefined;
}

/** First value of a tag, if any. */
function tagValue(ev: NostrEvent, name: string): string | undefined {
  for (const t of ev.tags) if (t[0] === name && t[1]) return t[1];
  return undefined;
}

/** The bus scope a plaintext event belongs to, if any. */
function scopeOf(ev: NostrEvent, spec: WireSpec | undefined): string | undefined {
  const h = tagValue(ev, "h");
  if (h) return `nip29:${h}`;
  if (ev.kind === 4) return "dm";
  const z = tagValue(ev, "z");
  if (z) return `c1:${spec?.v1ByZ.get(z) ?? z}`;
  return undefined;
}

/**
 * The wire's single ingestion point. EVERY transport funnels through here —
 * the web socket manager, the APK service's live `relayEvent` feed, and its
 * buffered drain — so there is exactly one routing rule:
 *
 *   - Concord V2 wraps whose stream key we hold → decrypt → rumor store.
 *   - V2 wraps we can't open yet (control/invite planes, key not derived yet)
 *     → parked pending store, drained later by whoever holds the key.
 *   - Everything else (NIP-29 kinds, DMs, sealed V1 outers) → armada-events.
 *     The store applies NIP-09 deletions itself.
 *
 * After the store write, the affected conversation scopes are announced on the
 * wire bus; hooks re-read the store. Writes are idempotent (stores dedupe by
 * id), so overlapping transports are harmless.
 */
export async function ingestWireEvents(sinks: WireSinks, events: NostrEvent[]): Promise<void> {
  if (events.length === 0) return;
  const spec = sinks.getSpec();
  const scopes = new Set<string>();

  // Split wraps from plaintext; group decryptable wraps per channel so the
  // (chunked, memoized) decode runs one batch per channel.
  const wrapsByChannel = new Map<ChannelV2, NostrEvent[]>();
  const toPark: NostrEvent[] = [];
  const plain: NostrEvent[] = [];
  for (const ev of events) {
    if (!ev || typeof ev.id !== "string" || typeof ev.kind !== "number") continue;
    if (WRAP_KINDS.has(ev.kind)) {
      const channel = spec?.v2ByPk.get(ev.pubkey);
      if (channel) {
        const list = wrapsByChannel.get(channel);
        if (list) list.push(ev);
        else wrapsByChannel.set(channel, [ev]);
      } else {
        toPark.push(ev);
      }
    } else {
      plain.push(ev);
    }
  }

  // V2: decrypt with the owning channel's stream keys → rumor store.
  for (const [channel, wraps] of wrapsByChannel) {
    const opened = await openChatBatch(wraps, channel);
    if (opened.length === 0) continue;
    writeRumors(opened);
    scopes.add(`c2:${channel.idHex}`);
  }
  // Wraps for streams we hold no key for (control plane, invites, or a
  // just-joined channel whose spec hasn't refreshed): park for the plane
  // hooks that do hold the keys. Peek+ack semantics keep this loss-proof.
  // Ring a doorbell naming the wrap's stream address: a hook that DOES hold
  // that stream's key (e.g. the active channel right after a rekey, before
  // the wire spec has refreshed its stream set) can drain the park instead
  // of sitting in dead air until the next poll.
  if (toPark.length > 0) {
    parkPendingWraps(toPark);
    for (const ev of toPark) scopes.add(`c2park:${ev.pubkey}`);
  }

  // Plaintext planes → the shared event store (NIP-09 applied by the store).
  if (plain.length > 0) {
    const store = await sinks.eventStore;
    for (const ev of plain) {
      try {
        await store.event(ev);
      } catch {
        // Duplicate or rejected — either way the store's state is authoritative.
      }
      const scope = scopeOf(ev, spec);
      if (scope) scopes.add(scope);
    }
  }

  if (scopes.size > 0) emitWireScopes(scopes);
}

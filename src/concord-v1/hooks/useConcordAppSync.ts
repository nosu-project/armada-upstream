import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelPseudonym } from "@/concord-v1/lib/derive";
import {
  buildInnerEvent,
  openMessageMulti,
  sealWithSignedInner,
  type OpenedMessage,
} from "@/concord-v1/lib/envelope";
import { KIND_COMMUNITY_WEBXDC } from "@/concord-v1/lib/kinds";

import type { AppStateMeta, AppStateUpdate, AppSync } from "@/hooks/useWebxdcApi";
import type { Channel, Community } from "@/concord-v1/lib/types";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "@nostrify/nostrify";

/** The held epoch keys for a channel: every retained epoch, newest first. */
function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The `#z` pseudonyms to query for a channel (one per held epoch). */
function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find(([n]) => n === name)?.[1];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * In-chat app coordination plane for a Concord (E2EE) channel, scoped to one
 * app session (`uuid`). Both state and realtime ride the sealed kind
 * {@link KIND_COMMUNITY_WEBXDC} (3310); realtime frames carry an inner
 * `["rt","1"]` tag and are folded out of the durable state list. Every event is
 * sealed under the channel key (the relay only sees opaque blobs under the
 * channel pseudonym).
 */
export function useConcordAppSync(
  community: Community | undefined,
  channel: Channel | undefined,
  uuid: string,
): AppSync {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const enabled = Boolean(community && channel && uuid && user);
  const channelIdHex = channel ? bytesToHex(channel.id) : null;
  const stateKey = useMemo(() => ["concord", "app-state", channelIdHex, uuid], [channelIdHex, uuid]);

  const { data: opened } = useQuery<OpenedMessage[]>({
    queryKey: stateKey,
    enabled,
    // Durable state arrives LIVE via the session subscription below; this poll
    // is only a slow healing backstop for a dropped socket (was an aggressive
    // 3s poll that ran for the whole app session).
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const epochKeys = readEpochKeys(channel!);
      const zs = channelPseudonyms(channel!);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_COMMUNITY_WEBXDC], "#z": zs, limit: 500 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      const out: OpenedMessage[] = [];
      const seen = new Set<string>();
      for (const ev of results.flat()) {
        try {
          const msg = openMessageMulti(ev, channel!.id, epochKeys);
          // Scope to this app session, durable state only (drop realtime frames).
          if (tagValue(msg.tags, "i") !== uuid) continue;
          if (tagValue(msg.tags, "rt") === "1") continue;
          if (seen.has(msg.messageId)) continue;
          seen.add(msg.messageId);
          out.push(msg);
        } catch {
          // not ours / invalid → skip
        }
      }
      out.sort((a, b) => a.ms - b.ms);
      return out;
    },
  });

  const stateUpdates = useMemo((): AppStateUpdate[] => {
    return (opened ?? []).map((m) => {
      let payload: unknown;
      try {
        payload = JSON.parse(m.content);
      } catch {
        payload = m.content;
      }
      return {
        payload,
        info: tagValue(m.tags, "info"),
        document: tagValue(m.tags, "document"),
        summary: tagValue(m.tags, "summary"),
      };
    });
  }, [opened]);

  const publishSealed = useCallback(
    async (content: string, extraTags: string[][]) => {
      if (!community || !channel || !user) return;
      const inner = buildInnerEvent({
        channelId: channel.id,
        epoch: channel.epoch,
        kind: KIND_COMMUNITY_WEBXDC,
        content,
        ms: Date.now(),
        extraTags,
      });
      const signedInner = await user.signer.signEvent(inner);
      const outer = sealWithSignedInner(signedInner, channel.key, channel.id, channel.epoch);
      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      );
    },
    [nostr, community, channel, user],
  );

  const sendState = useCallback(
    (payload: unknown, opts?: AppStateMeta) => {
      const extraTags: string[][] = [["i", uuid], ["alt", "Webxdc update"]];
      if (opts?.info) extraTags.push(["info", opts.info]);
      if (opts?.document) extraTags.push(["document", opts.document]);
      if (opts?.summary) extraTags.push(["summary", opts.summary]);
      void publishSealed(JSON.stringify(payload), extraTags);
    },
    [uuid, publishSealed],
  );

  const sendRealtime = useCallback(
    (data: Uint8Array) => {
      void publishSealed(bytesToBase64(data), [["i", uuid], ["rt", "1"], ["alt", "Webxdc realtime"]]);
    },
    [uuid, publishSealed],
  );

  // Session subscription: one live `req` for sealed 3310 frames on this app's
  // `#z` addresses. It carries BOTH planes — realtime frames (`rt:1`) are
  // delivered straight to the onRealtime listeners (sub-second, never stored),
  // and durable state frames (`rt` unset) are folded into the query cache so
  // state arrives live instead of on a poll. This is a session-scoped socket
  // (mounted only while an app is open), deliberately NOT on the always-on wire:
  // the wire is for ambient timeline/control ingestion, and routing latency-
  // sensitive realtime frames through the store would add a persist→re-read hop
  // and pollute the event store with ephemeral frames.
  const listenersRef = useRef(new Set<(data: Uint8Array) => void>());
  const selfPubkey = user?.pubkey;

  useEffect(() => {
    if (!enabled || !community || !channel) return;
    const controller = new AbortController();
    const epochKeys = readEpochKeys(channel);
    const zs = channelPseudonyms(channel);
    const since = Math.floor(Date.now() / 1000);

    for (const url of community.relays) {
      (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [{ kinds: [KIND_COMMUNITY_WEBXDC], "#z": zs, since }],
            { signal: controller.signal },
          )) {
            if (msg[0] !== "EVENT") {
              if (msg[0] === "CLOSED") break;
              continue;
            }
            try {
              const m = openMessageMulti(msg[2] as NostrEvent, channel.id, epochKeys);
              if (tagValue(m.tags, "i") !== uuid) continue;
              if (tagValue(m.tags, "rt") === "1") {
                // Realtime plane: deliver to listeners (skip our own echoes).
                if (m.author === selfPubkey) continue;
                const bytes = base64ToBytes(m.content);
                for (const cb of listenersRef.current) cb(bytes);
                continue;
              }
              // Durable state plane: fold the new frame into the cached list
              // (dedup by message id), so app state updates live.
              queryClient.setQueryData<OpenedMessage[]>(stateKey, (old) => {
                if (old?.some((e) => e.messageId === m.messageId)) return old;
                return [...(old ?? []), m].sort((a, b) => a.ms - b.ms);
              });
            } catch {
              // not ours / invalid → skip
            }
          }
        } catch {
          // subscription ended
        }
      })();
    }

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nostr, channelIdHex, uuid, selfPubkey]);

  const onRealtime = useCallback((cb: (data: Uint8Array) => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return useMemo<AppSync>(
    () => ({ stateUpdates, sendState, sendRealtime, onRealtime }),
    [stateUpdates, sendState, sendRealtime, onRealtime],
  );
}

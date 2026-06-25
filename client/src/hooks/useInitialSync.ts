import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  CONCORD_ENABLED,
  CONCORD_LIST_D_TAG,
  CONCORD_LIST_KIND,
  type ConcordList,
} from "@/lib/concord";
import { channelPseudonym } from "@/lib/concord/derive";
import { openMemoizedBatch } from "@/lib/concord/decodeCache";
import { type OpenedMessage } from "@/lib/concord/envelope";
import { acceptInvite, type CommunityInvite } from "@/lib/concord/invite";
import { KIND_COMMUNITY_DELETE, KIND_COMMUNITY_MESSAGE } from "@/lib/concord/kinds";
import type { Channel, Community } from "@/lib/concord/types";
import {
  KIND_GROUP_CHAT,
  KIND_USER_GROUPS,
  parseGroupListTags,
  type GroupRef,
} from "@/lib/nip29";
import { EncryptedSettingsSchema } from "@/lib/schemas";

import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-78 application-data kind (Armada's encrypted settings). */
const SETTINGS_KIND = 30078;
/** `d` tag identifying Armada's settings event. */
const SETTINGS_D = "armada/metadata";
/** NIP-88 poll kind — polls render inline in the group timeline. */
const KIND_POLL = 1068;
/** Kinds shown in a group timeline (mirrors useGroupMessages). */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];
/** How many messages to catch up per channel (mirrors useGroupMessages PAGE_SIZE). */
const PAGE_SIZE = 50;
/** Cap on channels we eagerly catch up, so a user in dozens of groups isn't blocked forever. */
const MAX_CATCHUP_CHANNELS = 8;
/** Cap on Concord communities we eagerly catch up. */
const MAX_CATCHUP_COMMUNITIES = 6;

/** Overall timeout for the whole sync so a dead relay never traps the user. */
const SYNC_TIMEOUT_MS = 12_000;
/** Per-step network timeout. */
const STEP_TIMEOUT_MS = 8_000;

/** A phase of the post-login sync. */
export type SyncPhase = "settings" | "groups" | "messages" | "concord" | "done";

/** One line in the boot-log terminal the SyncGate renders. */
export interface SyncLogLine {
  id: string;
  text: string;
  status?: string;
  tone?: "ok" | "info" | "warn";
}

export interface SyncState {
  phase: SyncPhase;
  /** Accumulating boot log, newest last. Drives the terminal feed. */
  log: SyncLogLine[];
  /** True once the sync has finished (or timed out). */
  done: boolean;
}

/** The line shown (in-progress, no status) when a phase begins. */
const PHASE_OPENING: Record<Exclude<SyncPhase, "done">, string> = {
  settings: "establishing secure channel",
  groups: "mounting channel directory",
  messages: "syncing recent transmissions",
  concord: "decrypting community vault",
};

function sortDedupe(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

/** Held epoch keys for a channel, newest-first (mirrors useConcordChannel). */
function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The `#z` pseudonyms to query for a channel (one per held epoch). */
function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/**
 * Fetch + decrypt one Concord channel's newest messages from the community's
 * relays and prime the `["concord","channel",<channelIdHex>]` cache with the
 * opened messages — exactly the shape and read path of useConcordChannelMessages
 * (kinds 3300/3305 over `#z` pseudonyms, opened with openMessageMulti, deletes
 * applied, sorted by ms). Best-effort: a relay miss or undecryptable blob is
 * skipped, never thrown past the caller.
 */
async function catchUpConcordChannel(
  nostr: ReturnType<typeof useNostr>["nostr"],
  queryClient: ReturnType<typeof useQueryClient>,
  community: Community,
  channel: Channel,
  signal: AbortSignal,
): Promise<void> {
  const epochKeys = readEpochKeys(channel);
  const zs = channelPseudonyms(channel);
  const results = await Promise.all(
    community.relays.map((url) =>
      nostr
        .relay(url)
        .query([{ kinds: [KIND_COMMUNITY_MESSAGE, KIND_COMMUNITY_DELETE], "#z": zs, limit: 500 }], { signal })
        .catch(() => [] as NostrEvent[]),
    ),
  );

  const byId = new Map<string, OpenedMessage>();
  const deletes = new Map<string, Set<string>>();
  // Memoized + chunked open so the catch-up shares the channel hook's
  // decode-once cache (no double-decrypt) and never freezes the boot UI.
  const allOpened = await openMemoizedBatch(results.flat(), channel.id, epochKeys, { signal });
  for (const opened of allOpened) {
    if (opened.kind === KIND_COMMUNITY_DELETE) {
      const target = opened.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      let authors = deletes.get(target);
      if (!authors) deletes.set(target, (authors = new Set()));
      authors.add(opened.author);
      continue;
    }
    byId.set(opened.messageId, opened);
  }
  for (const [id, msg] of byId) {
    if (deletes.get(id)?.has(msg.author)) byId.delete(id);
  }
  const opened = [...byId.values()].sort((a, b) => a.ms - b.ms);
  if (opened.length === 0) return;
  queryClient.setQueryData<OpenedMessage[]>(["concord", "channel", bytesToHex(channel.id)], (old) =>
    old && old.length > 0 ? old : opened,
  );
}

/**
 * Runs the one-time post-login sync for `pubkey` and reports live progress:
 *
 *   1. Pull encrypted settings (NIP-78, kind 30078, d="armada/metadata") and
 *      seed the `["encrypted-settings", pubkey]` cache so NostrSync applies
 *      theme/relay config without a second fetch.
 *   2. Pull the kind 10009 group list (joined channels + servers) and seed the
 *      `["nip29","user-groups",pubkey]` cache.
 *   3. Catch up on the newest page of messages for each joined channel (capped),
 *      priming the same caches useGroupMessages reads so timelines render
 *      instantly once the gate lifts.
 *   4. Catch up on Concord (encrypted communities): decrypt the membership list,
 *      rehydrate each community, and decrypt its channels' newest messages,
 *      priming the ["concord","channel",…] caches useConcordChannelMessages reads.
 *
 * Every step is best-effort and bounded by a timeout — the gate must never trap
 * a user behind a slow or unreachable relay. Returns `{ phase, label, done }`.
 * Pass `pubkey === undefined` to stay idle (done immediately).
 */
export function useInitialSync(pubkey: string | undefined): SyncState {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const [state, setState] = useState<SyncState>({
    phase: "settings",
    log: [],
    done: pubkey === undefined,
  });

  // Guard so we run the sequence exactly once per fresh pubkey.
  const ranForRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!pubkey) {
      setState({ phase: "done", log: [], done: true });
      return;
    }
    // Wait until the signer for this pubkey is the active user (settings + the
    // group list need NIP-44 to decrypt). Until then, keep showing the spinner.
    if (!user || user.pubkey !== pubkey) return;
    if (ranForRef.current === pubkey) return;
    ranForRef.current = pubkey;

    let cancelled = false;
    const overall = AbortSignal.timeout(SYNC_TIMEOUT_MS);
    const log: SyncLogLine[] = [];

    /** Open a phase: push an in-progress line, return its id. */
    const begin = (phase: Exclude<SyncPhase, "done">): string => {
      const id = `${phase}`;
      log.push({ id, text: PHASE_OPENING[phase] });
      if (!cancelled) setState({ phase, log: [...log], done: false });
      return id;
    };

    /** Resolve a phase line with a status chip. */
    const resolve = (id: string, status: string, tone: SyncLogLine["tone"] = "ok") => {
      const line = log.find((l) => l.id === id);
      if (line) {
        line.status = status;
        line.tone = tone;
      }
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    /** Append a standalone, already-resolved line. */
    const note = (id: string, text: string, status?: string, tone: SyncLogLine["tone"] = "info") => {
      log.push({ id, text, status, tone });
      if (!cancelled) setState((s) => ({ ...s, log: [...log] }));
    };

    const stepSignal = () => AbortSignal.any([overall, AbortSignal.timeout(STEP_TIMEOUT_MS)]);

    void (async () => {
      const shortPk = `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
      note("auth", `authenticated ${shortPk}`, "OK", "ok");

      // ── 1. Encrypted settings ───────────────────────────────────────────
      const sId = begin("settings");
      let settingsFound = false;
      try {
        if (user.signer.nip44) {
          const events = await nostr.query(
            [{ kinds: [SETTINGS_KIND], authors: [pubkey], "#d": [SETTINGS_D], limit: 1 }],
            { signal: stepSignal() },
          );
          const event = events.sort((a, b) => b.created_at - a.created_at)[0];
          if (event?.content) {
            const decrypted = await user.signer.nip44.decrypt(pubkey, event.content);
            const parsed = EncryptedSettingsSchema.safeParse(JSON.parse(decrypted));
            if (parsed.success && !cancelled) {
              queryClient.setQueryData(["encrypted-settings", pubkey], parsed.data);
              settingsFound = true;
            }
          }
        }
      } catch {
        // Best-effort; fall through to the next step.
      }
      resolve(sId, settingsFound ? "RESTORED" : "DEFAULTS", settingsFound ? "ok" : "info");
      if (cancelled) return;

      // ── 2. Group list (kind 10009) ──────────────────────────────────────
      const gId = begin("groups");
      let groups: GroupRef[] = [];
      try {
        const events = await nostr.query(
          [{ kinds: [KIND_USER_GROUPS], authors: [pubkey], limit: 1 }],
          { signal: stepSignal() },
        );
        const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
        if (latest) {
          const tags = [...latest.tags];
          if (latest.content && user.signer.nip44) {
            try {
              const decrypted = await user.signer.nip44.decrypt(pubkey, latest.content);
              const privateTags = JSON.parse(decrypted);
              if (Array.isArray(privateTags)) {
                for (const t of privateTags) if (Array.isArray(t)) tags.push(t as string[]);
              }
            } catch {
              // Public-only fallback.
            }
          }
          const list = parseGroupListTags(tags);
          groups = list.groups;
          if (!cancelled) {
            queryClient.setQueryData(["nip29", "user-groups", pubkey], {
              event: latest,
              groups: list.groups,
              servers: list.servers,
            });
          }
        }
      } catch {
        // Best-effort.
      }
      resolve(gId, `${groups.length} ${groups.length === 1 ? "channel" : "channels"}`);
      if (cancelled) return;

      // ── 3. Catch up on messages for joined channels ─────────────────────
      const mId = begin("messages");
      const channels = groups.slice(0, MAX_CATCHUP_CHANNELS);
      let messageCount = 0;
      if (channels.length > 0) {
        await Promise.all(
          channels.map(async ({ id, relay }) => {
            try {
              const events = await nostr.relay(relay).query(
                [{ kinds: TIMELINE_KINDS, "#h": [id], limit: PAGE_SIZE }],
                { signal: stepSignal() },
              );
              if (cancelled || events.length === 0) return;
              messageCount += events.length;
              const sorted = sortDedupe(events);
              // The relay() wrapper has already mirrored these into IndexedDB;
              // seed the in-memory cache too so the channel renders instantly.
              queryClient.setQueryData<NostrEvent[]>(["nip29", "messages", relay, id], (old) =>
                old && old.length > 0 ? old : sorted,
              );
            } catch {
              // Best-effort per channel.
            }
          }),
        );
      }
      resolve(mId, `${messageCount} cached`);
      if (cancelled) return;

      // ── 4. Catch up on Concord (encrypted communities) ──────────────────
      // Concord membership is a self-encrypted list (kind 30078, d=armada/concord)
      // that carries the room KEYS. Rehydrate each community from its invite and
      // decrypt the newest messages per channel, priming the same
      // ["concord","channel",<channelIdHex>] cache useConcordChannelMessages reads.
      if (CONCORD_ENABLED && user.signer.nip44) {
        const cId = begin("concord");
        let communityCount = 0;
        try {
          const listEvents = await nostr.query(
            [{ kinds: [CONCORD_LIST_KIND], authors: [pubkey], "#d": [CONCORD_LIST_D_TAG], limit: 1 }],
            { signal: stepSignal() },
          );
          const latest = listEvents.sort((a, b) => b.created_at - a.created_at)[0];
          let list: ConcordList | undefined;
          if (latest?.content) {
            const decrypted = await user.signer.nip44.decrypt(pubkey, latest.content);
            const parsed = JSON.parse(decrypted) as Partial<ConcordList>;
            list = {
              entries: Array.isArray(parsed.entries) ? parsed.entries : [],
              tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
            };
            // Seed the membership list so the Concord UI opens instantly.
            if (!cancelled) {
              queryClient.setQueryData(["concord", "list", pubkey], { event: latest, list });
            }
          }

          // Rehydrate communities and catch up each channel's messages.
          const communities: Community[] = [];
          for (const entry of list?.entries.slice(0, MAX_CATCHUP_COMMUNITIES) ?? []) {
            const invite = entry.current.keys.invite as CommunityInvite | undefined;
            if (!invite) continue;
            try {
              communities.push(acceptInvite(invite));
            } catch {
              // Unreadable bundle — skip.
            }
          }
          communityCount = communities.length;

          await Promise.all(
            communities.flatMap((community) =>
              community.channels.map((channel) =>
                catchUpConcordChannel(nostr, queryClient, community, channel, stepSignal()).catch(
                  () => {
                    // Best-effort per channel.
                  },
                ),
              ),
            ),
          );
        } catch {
          // Best-effort; never block login on Concord.
        }
        resolve(cId, `${communityCount} ${communityCount === 1 ? "community" : "communities"}`);
      }
      if (cancelled) return;

      // NOTE: we deliberately do NOT write the settings sync watermark here.
      // NostrSync owns applying the fetched settings (theme/relay config) into
      // AppConfig and only then records the watermark; writing it now would make
      // NostrSync's timestamp guard skip the very settings we just primed. The
      // "don't re-gate on reload" behavior is handled by useFreshLogin instead.
      note("ready", "all systems nominal", "READY", "ok");
      if (!cancelled) setState((s) => ({ ...s, phase: "done", done: true }));
    })();

    return () => {
      cancelled = true;
    };
  }, [pubkey, user, nostr, queryClient]);

  return state;
}

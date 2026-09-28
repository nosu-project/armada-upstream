/**
 * The current user's own replaceable/addressable events kept continuously in
 * sync across devices (see {@link ../components/SelfSync}): a standing REQ
 * streams new versions into the IndexedDB cache, then the owning query-key
 * PREFIXES are invalidated (not setQueryData) so each hook's own
 * merge-never-clobber / bad-decrypt guards reconcile the change.
 */

import { KIND_RELAY_LIST } from "@/lib/nip65";
import { SETTINGS_DTAGS, SETTINGS_KIND, settingsDocForDTag } from "@/lib/settingsDocs";
import { DM_CONVERSATIONS_EVENT_TAG } from "@/lib/dmConversationIndex";

/** NIP-02 contact/follow list. */
export const KIND_FOLLOW_LIST = 3;
/** NIP-51 mute list (kind 10000). */
export const KIND_MUTE_LIST = 10000;
/** NIP-51 "simple groups" list — Armada's NIP-29 server/channel list (10009). */
export const KIND_USER_GROUPS = 10009;
/** NIP-51 search-relay list (10007). */
export const KIND_SEARCH_RELAYS = 10007;
/** NIP-17 DM relay list (10050). */
export const KIND_DM_RELAYS = 10050;
/** BUD-03 Blossom media server list (10063). */
export const KIND_BLOSSOM_SERVERS = 10063;
/** NIP-51 user custom emoji list (10030). */
export const KIND_USER_EMOJIS = 10030;
/**
 * Concord community list vault fragments (CORD-02 §8, 33302). One addressable
 * event per fragment `d`, so echo-dedup must key per `d`.
 */
export const KIND_COMMUNITY_LIST_FRAG = 33302;
/** Concord invite list — the creator's minted-link bookkeeping (CORD-05, 13303). */
export const KIND_INVITE_LIST = 13303;
/** NIP-78 application-specific data (30078) — vault, settings, and private app data. */
export const KIND_APP_SPECIFIC = SETTINGS_KIND;

/** Tag shared by per-installation encrypted GIF-favorite shards. */
export const T_ARMADA_GIF_FAVORITES = "armada-gif-favorites";
/** Tag shared by per-installation encrypted DM-conversation index shards. */
export const T_ARMADA_DM_CONVERSATIONS = DM_CONVERSATIONS_EVENT_TAG;

/**
 * Topic-scoped kind-30078 documents with dynamic per-installation `d` tags;
 * their public `t` marker bounds the subscription.
 */
export const SELF_SYNC_TOPIC_TAGS: string[] = [
  T_ARMADA_GIF_FAVORITES,
  T_ARMADA_DM_CONVERSATIONS,
];

/** The first recognized self-state topic, wherever it appears in the tag set. */
export function selfSyncTopicOf(tags: readonly (readonly string[])[]): string | undefined {
  for (const [name, value] of tags) {
    if (name === "t" && value !== undefined && SELF_SYNC_TOPIC_TAGS.includes(value)) {
      return value;
    }
  }
  return undefined;
}

/** The NIP-01 version retained for one replaceable self-state coordinate. */
export interface SelfSyncEventVersion {
  created_at: number;
  id: string;
}

/**
 * Admit a replaceable event into a standing stream's echo guard. NIP-01 breaks
 * equal-second ties by the LOWER id; timestamp-only guards can freeze on the wrong copy.
 */
export function admitSelfSyncEvent(
  seen: Map<string, SelfSyncEventVersion>,
  event: SelfSyncEventVersion & { kind: number },
  dTag?: string,
): boolean {
  const coordinate = dTag !== undefined ? `${event.kind}:${dTag}` : String(event.kind);
  if (!isNewerSelfSyncVersion(seen.get(coordinate), event)) return false;
  seen.set(coordinate, { created_at: event.created_at, id: event.id });
  return true;
}

/** Whether `event` beats `previous` under NIP-01's replaceable ordering. */
export function isNewerSelfSyncVersion(
  previous: SelfSyncEventVersion | undefined,
  event: SelfSyncEventVersion,
): boolean {
  return previous === undefined
    || event.created_at > previous.created_at
    || (event.created_at === previous.created_at && event.id < previous.id);
}

/**
 * Stage `event` as the pending version of `coordinate`, keeping the NIP-01
 * winner; new coordinates are refused past `maxCoordinates`. Returns whether it
 * is now pending. The first version is staged unverified, but every decision
 * that DROPS a version is made against a verified one (relays can serve forged
 * events under the user's pubkey). `verify` should memoize.
 */
export function stageNewestPerCoordinate<T extends SelfSyncEventVersion>(
  pending: Map<string, T>,
  coordinate: string,
  event: T,
  maxCoordinates: number,
  verify: (event: T) => boolean,
): boolean {
  const previous = pending.get(coordinate);
  if (previous === undefined) {
    if (pending.size >= maxCoordinates) {
      for (const [staged, candidate] of pending) {
        if (!verify(candidate)) pending.delete(staged);
      }
      if (pending.size >= maxCoordinates) return false;
    }
    pending.set(coordinate, event);
    return true;
  }
  if (previous.id === event.id) return false;
  if (isNewerSelfSyncVersion(previous, event)) {
    if (!verify(event)) return false;
  } else if (verify(previous)) {
    return false;
  }
  pending.set(coordinate, event);
  return true;
}

/**
 * Kinds synced with a plain `{ authors:[me], kinds }` filter: kind 3, the
 * 10000–19999 replaceables, and every 33302 fragment. Kind 30078 uses
 * {@link SELF_SYNC_DTAGS} / {@link SELF_SYNC_TOPIC_TAGS} filters instead.
 */
export const SELF_SYNC_REPLACEABLE_KINDS: number[] = [
  KIND_FOLLOW_LIST,
  KIND_MUTE_LIST,
  KIND_RELAY_LIST,
  KIND_SEARCH_RELAYS,
  KIND_USER_GROUPS,
  KIND_DM_RELAYS,
  KIND_BLOSSOM_SERVERS,
  KIND_USER_EMOJIS,
  KIND_COMMUNITY_LIST_FRAG,
  KIND_INVITE_LIST,
];

/** Armada's settings-document `d` tags on kind 30078. */
export const SELF_SYNC_DTAGS: string[] = SETTINGS_DTAGS;

/** Query-key prefixes to invalidate for an incoming self event; empty if unrecognised. */
export function queryKeysForSelfEvent(
  kind: number,
  dTag: string | undefined,
  topicTag?: string,
): readonly (readonly string[])[] {
  switch (kind) {
    case KIND_FOLLOW_LIST:
      return [["follow-list"]];
    case KIND_MUTE_LIST:
      return [["mute-list"]];
    case KIND_SEARCH_RELAYS:
      return [["search-relay-list"]];
    case KIND_USER_GROUPS:
      return [["nip29", "user-groups"]];
    case KIND_DM_RELAYS:
      return [["dm-relay-list"]];
    case KIND_BLOSSOM_SERVERS:
      return [["blossom-server-list"]];
    case KIND_USER_EMOJIS:
      return [["custom-emojis"]];
    case KIND_COMMUNITY_LIST_FRAG:
      return [["concord", "list"]];
    case KIND_INVITE_LIST:
      return [["concord", "invite-list"]];
    case KIND_APP_SPECIFIC: {
      const doc = dTag !== undefined ? settingsDocForDTag(dTag) : undefined;
      if (doc) return [["settings-doc", doc]];
      if (topicTag === T_ARMADA_GIF_FAVORITES) return [["favorite-gifs-sync"]];
      if (topicTag === T_ARMADA_DM_CONVERSATIONS) return [["dm-conversations-sync"]];
      return [];
    }
    default:
      return [];
  }
}

/**
 * Query owners to re-read when the NIP-65 relay set moves; derived from the
 * same routing table so new kinds can't miss relay migration.
 */
export const SELF_SYNC_OWNER_QUERY_KEYS: readonly (readonly string[])[] = (() => {
  const keys = [
    ...SELF_SYNC_REPLACEABLE_KINDS.flatMap((kind) => queryKeysForSelfEvent(kind, undefined)),
    ...SELF_SYNC_DTAGS.flatMap((dTag) => queryKeysForSelfEvent(KIND_APP_SPECIFIC, dTag)),
    ...SELF_SYNC_TOPIC_TAGS.flatMap((topic) =>
      queryKeysForSelfEvent(KIND_APP_SPECIFIC, undefined, topic)),
  ];
  const unique = new Map(keys.map((key) => [key.join("\u0000"), key] as const));
  return [...unique.values()];
})();

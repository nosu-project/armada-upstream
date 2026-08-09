/**
 * The catalogue of the current user's own replaceable / addressable events that
 * the client keeps CONTINUOUSLY in sync — synced into the local cache and kept
 * fresh with a standing REQ (see {@link ../components/SelfSync}).
 *
 * These are the events that describe WHO YOU ARE and WHAT YOU'VE JOINED across
 * devices: follow list, mute list, the NIP-29 server/channel list, the Concord
 * membership vaults, DM/Blossom relay lists, and Armada's own NIP-78 settings.
 * A change on device B (join a server, add a Concord community, mute someone)
 * must reach device A without a manual refetch — otherwise the community rail
 * "struggles to sync between devices", which is exactly what this fixes.
 *
 * The sync discipline (matching the wire's, but for self-state rather than
 * conversation timelines):
 *
 *   1. A standing REQ `{ authors:[me], kinds:[…] }` (plus scoped filters for
 *      Armada's addressable kind-30078 documents) streams every new version.
 *   2. Each event lands in the `armada-events` IndexedDB cache first — the
 *      NostrBatcher mirrors everything that flows out of `.req()`.
 *   3. Then the matching TanStack query key(s) are invalidated so the owning
 *      hook re-reads (relay + cache) and reconciles through its OWN merge /
 *      decrypt-failed guards. We deliberately invalidate rather than
 *      setQueryData: the list hooks carry delicate merge-never-clobber and
 *      "never overwrite a populated vault with a bad decrypt" logic, and
 *      re-running their queryFns reuses that safety instead of duplicating it.
 *
 * Query keys here are the PREFIXES the hooks invalidate on their own mutations
 * (e.g. `["nip29","user-groups"]`, `["concord","list"]`) — invalidating the
 * prefix matches every pubkey/relayKey-suffixed variant, so we don't need to
 * know the exact suffix (relayKey, etc.) a given mounted hook used.
 */

import { SETTINGS_DTAGS, SETTINGS_KIND, settingsDocForDTag } from "@/lib/settingsDocs";

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
/** Concord community list — the membership vault (CORD-02, 13302). */
export const KIND_COMMUNITY_LIST = 13302;
/** Concord invite list — the creator's minted-link bookkeeping (CORD-05, 13303). */
export const KIND_INVITE_LIST = 13303;
/** NIP-78 application-specific data (30078) — vault, settings, and private app data. */
export const KIND_APP_SPECIFIC = SETTINGS_KIND;

/** Tag shared by per-installation encrypted GIF-favorite shards. */
export const T_ARMADA_GIF_FAVORITES = "armada-gif-favorites";

/**
 * The bare replaceable kinds (10000–19999 band + kind 3) synced with a simple
 * `{ authors:[me], kinds:[…] }` filter. Addressable kind 30078 is handled
 * separately with a `#d` filter (see {@link SELF_SYNC_DTAGS}).
 */
export const SELF_SYNC_REPLACEABLE_KINDS: number[] = [
  KIND_FOLLOW_LIST,
  KIND_MUTE_LIST,
  KIND_SEARCH_RELAYS,
  KIND_USER_GROUPS,
  KIND_DM_RELAYS,
  KIND_BLOSSOM_SERVERS,
  KIND_USER_EMOJIS,
  KIND_COMMUNITY_LIST,
  KIND_INVITE_LIST,
];

/**
 * The `d` tags to sync on the addressable kind-30078 documents (distinguished
 * from other apps' kind-30078 data by `d`) — Armada's six settings documents.
 */
export const SELF_SYNC_DTAGS: string[] = SETTINGS_DTAGS;

/**
 * Resolve the query-key prefix(es) to invalidate for an incoming self event.
 * Returns an empty array for anything we don't recognise (never invalidate
 * blindly). For kind 30078 the `d` tag selects the Armada settings document.
 */
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
      // The rail's servers (`r` tags) + joined channels. This list IS the
      // source the rail renders, so re-reading it is the whole update.
      return [["nip29", "user-groups"]];
    case KIND_DM_RELAYS:
      return [["dm-relay-list"]];
    case KIND_BLOSSOM_SERVERS:
      return [["blossom-server-list"]];
    case KIND_USER_EMOJIS:
      return [["custom-emojis"]];
    case KIND_COMMUNITY_LIST:
      return [["concord", "list"]];
    case KIND_INVITE_LIST:
      return [["concord", "invite-list"]];
    case KIND_APP_SPECIFIC: {
      // Each settings document has its own query, so only the one that
      // actually changed re-reads and re-applies.
      const doc = dTag !== undefined ? settingsDocForDTag(dTag) : undefined;
      if (doc) return [["settings-doc", doc]];
      if (topicTag === T_ARMADA_GIF_FAVORITES) return [["favorite-gifs-sync"]];
      return [];
    }
    default:
      return [];
  }
}

import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { BOT_MANIFEST_KIND, parseBotManifest, type BotCommandEntry } from "@/lib/botCommands";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Widely-indexed relays queried for manifests alongside the app's own.
 *
 * A conversation's relay is not a reliable place to find a bot's manifest: some
 * drop events from non-members, and in practice they also lag (a bot that
 * republishes its interface may land on the indexers minutes before its
 * community relay catches up, or never). Reading the union and taking the newest
 * per author makes a manifest resolvable regardless of which relay is behind.
 */
export const BOT_DISCOVERY_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://purplepag.es",
];

/** Relays cap how many authors one filter may name; stay well inside that. */
const AUTHOR_CHUNK = 50;

/** The bits of a participant's profile the picker renders. */
export interface BotRosterProfile {
  name?: string;
  picture?: string;
}

export interface BotManifestsResult {
  /** Every command of every bot present, flattened and ready to render or parse. */
  entries: BotCommandEntry[];
  /** Hex pubkeys of the bots in this conversation, whether or not they publish a manifest. */
  bots: string[];
  /**
   * Profiles of everyone in the conversation, a by-product of the bot sweep.
   * Surfaced so a `user` argument's member picker can search by name and show
   * faces without a second lookup.
   */
  profiles: Record<string, BotRosterProfile>;
  /** Nothing known yet and a fetch is in flight. */
  isLoading: boolean;
  /** A refresh is in flight behind data we already have. */
  isFetching: boolean;
}

const EMPTY: string[] = [];

/** Query `kinds` for `authors` in author-sized chunks, over an explicit relay set. */
async function queryChunked(
  query: (filters: { kinds: number[]; authors: string[] }[], opts: { signal: AbortSignal }) => Promise<NostrEvent[]>,
  kinds: number[],
  authors: string[],
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  for (let i = 0; i < authors.length; i += AUTHOR_CHUNK) {
    const chunk = authors.slice(i, i + AUTHOR_CHUNK);
    out.push(...(await query([{ kinds, authors: chunk }], { signal })));
  }
  return out;
}

/**
 * The newest event of `kind` per author. A relay may answer with whatever it
 * likes, so both the kind and the author are re-checked here rather than trusted
 * from the filter: a bot's manifest is newer than its profile, so a relay
 * returning the manifest to a kind-0 query would otherwise win the
 * newest-per-author race and make the bot look like it has no `bot` flag at all.
 */
function newestPerAuthor(events: NostrEvent[], asked: Set<string>, kind: number): Map<string, NostrEvent> {
  const best = new Map<string, NostrEvent>();
  for (const ev of events) {
    if (ev.kind !== kind || !asked.has(ev.pubkey)) continue;
    const held = best.get(ev.pubkey);
    if (!held || ev.created_at > held.created_at) best.set(ev.pubkey, ev);
  }
  return best;
}

/**
 * Resolve the bot commands available in a conversation.
 *
 * Discovery is two-stage, which is what keeps it cheap in a large room. First the
 * participants' `kind:0` metadata says which of them are bots (NIP-24's `bot`
 * flag — the same signal the Bot pill renders from). Only those few get a
 * manifest query, so a 500-member channel costs one profile sweep and a lookup
 * for the handful of bots, not five hundred lookups.
 *
 * A manifest is untrusted: one that fails validation is ignored entirely rather
 * than partially rendered, and a bot with no valid manifest simply contributes
 * no commands.
 *
 * Discovery warms when the conversation opens rather than when a `/` is typed:
 * the composer has to know whether any bot is present before the user types
 * anything, in order to decide whether to offer Commands at all. Warming here
 * also means the `/` menu is already populated by the time it is opened. A
 * conversation with no roster (a plain DM) fetches nothing.
 */
export function useBotManifests(memberPubkeys: string[] | undefined): BotManifestsResult {
  const { nostr } = useNostr();
  const { config } = useAppContext();

  // Sorted + joined so the query key is stable under member-list reordering, and
  // changes the moment the participant set actually changes.
  const members = useMemo(
    () => (memberPubkeys ? [...new Set(memberPubkeys)].sort() : EMPTY),
    [memberPubkeys],
  );
  const membersKey = members.join(",");

  const botsQuery = useQuery({
    queryKey: ["bot-flags", membersKey],
    queryFn: async ({ signal }) => {
      const asked = new Set(members);
      const events = await queryChunked(
        (filters, opts) => nostr.query(filters, opts),
        [0],
        members,
        signal,
      );
      const bots: string[] = [];
      const profiles: Record<string, BotRosterProfile> = {};
      for (const [pubkey, ev] of newestPerAuthor(events, asked, 0)) {
        let meta: { bot?: unknown; name?: unknown; display_name?: unknown; picture?: unknown };
        try {
          meta = JSON.parse(ev.content);
        } catch {
          continue; // A profile we cannot parse is simply not a bot.
        }
        if (meta?.bot === true) bots.push(pubkey);
        profiles[pubkey] = {
          name: typeof meta?.name === "string"
            ? meta.name
            : typeof meta?.display_name === "string"
              ? meta.display_name
              : undefined,
          picture: typeof meta?.picture === "string" ? meta.picture : undefined,
        };
      }
      return { bots: bots.sort(), profiles };
    },
    enabled: members.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const bots = botsQuery.data?.bots ?? EMPTY;
  const botsKey = bots.join(",");

  const relays = useMemo(
    () => [...new Set([...config.appRelays, ...BOT_DISCOVERY_RELAYS])],
    [config.appRelays],
  );

  const manifestsQuery = useQuery({
    queryKey: ["bot-manifests", botsKey],
    queryFn: async ({ signal }) => {
      const asked = new Set(bots);
      const events = await queryChunked(
        (filters, opts) => nostr.group(relays).query(filters, opts),
        [BOT_MANIFEST_KIND],
        bots,
        signal,
      );
      const entries: BotCommandEntry[] = [];
      for (const [pubkey, ev] of newestPerAuthor(events, asked, BOT_MANIFEST_KIND)) {
        // The newest manifest is the only one that counts: a bot that breaks its
        // own latest edition has no interface, rather than falling back to a
        // stale one it has already retired.
        const manifest = parseBotManifest(ev.content);
        if (!manifest) continue;
        for (const command of manifest.commands) entries.push({ bot: pubkey, command });
      }
      return entries;
    },
    enabled: bots.length > 0,
    // Republishing is the one mechanism a bot has to change its interface, so a
    // cached manifest must not be assumed current for the whole session. Bounded
    // rather than live: this refetches on the next mount past the window, and
    // never polls a bot that has no manifest at all.
    staleTime: 5 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    entries: manifestsQuery.data ?? [],
    bots,
    profiles: botsQuery.data?.profiles ?? {},
    isLoading:
      (botsQuery.isLoading && botsQuery.fetchStatus !== "idle") ||
      (manifestsQuery.isLoading && manifestsQuery.fetchStatus !== "idle"),
    isFetching: botsQuery.isFetching || manifestsQuery.isFetching,
  };
}

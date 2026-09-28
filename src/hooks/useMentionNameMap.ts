import { useNostr } from '@nostrify/react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { authorQueryOptions } from '@/hooks/useAuthor';
import type { AuthorResult } from '@/lib/authorCache';
import { useEventStore } from '@/hooks/useEventStore';
import { demandProfiles } from '@/sync/profileSync';

import type { NostrRumor } from "@/lib/nostrRumor";

const HEX64 = /^[0-9a-f]{64}$/i;

/** Non-notifying mention tag (Buzz's reference-only mention); treated like `p` here. */
const MENTION_REFERENCE_TAG = 'mention';

export interface MentionNameMap {
  byName: Map<string, string>;
  regex: RegExp | null;
}

const EMPTY: MentionNameMap = { byName: new Map(), regex: null };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `display_name`, `name`, and the NIP-05 local part — mirrors Buzz's alias set. */
function aliasesFor(data: AuthorResult | undefined): string[] {
  const md = data?.metadata;
  if (!md) return [];
  const out: string[] = [];
  const push = (s: string | undefined) => {
    const t = s?.trim();
    if (t) out.push(t);
  };
  push(md.display_name);
  push(md.name);
  const nip05 = md.nip05?.trim();
  if (nip05) {
    push(nip05.startsWith('_@') ? nip05.slice(2) : nip05.split('@')[0]);
  }
  return out;
}

/**
 * Longest-first so longer names beat prefixes. The `@` must not follow a word char, `@`, `.`
 * or `/` (emails, handles, paths).
 */
function buildMentionRegex(names: string[]): RegExp | null {
  const valid = names.filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  if (valid.length === 0) return null;
  const alts = valid.map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\w@./])@(${alts})(?=[\\s,;.!?:)\\]}'"]|$)`, 'giu');
}

/**
 * Tagged pubkeys worth resolving: only if the content contains `@`, since each costs a kind-0
 * fetch and verify, and `p`-tag-heavy messages without mention text are typical spam.
 */
export function mentionTagPubkeys(event: NostrRumor): string[] {
  if (!event.content.includes('@')) return [];
  const set = new Set<string>();
  for (const tag of event.tags) {
    if ((tag[0] === 'p' || tag[0] === MENTION_REFERENCE_TAG) && tag[1] && HEX64.test(tag[1])) {
      set.add(tag[1].toLowerCase());
    }
  }
  return [...set];
}

export function useMentionNameMap(event: NostrRumor): MentionNameMap {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  const pubkeys = useMemo(() => mentionTagPubkeys(event), [event.tags, event.content]); // eslint-disable-line react-hooks/exhaustive-deps

  // The author queries only READ; declare the pubkeys to the profile sync topic so unseen
  // targets resolve.
  const pubkeysKey = pubkeys.join(' ');
  useEffect(() => {
    if (pubkeys.length === 0) return;
    return demandProfiles(pubkeys, { nostr, queryClient });
    // `pubkeysKey` captures the list by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkeysKey, nostr, queryClient]);

  const results = useQueries({
    queries: pubkeys.map((pk) => authorQueryOptions(queryClient, eventStore, pk)),
  });

  // Stable serialization so the map/regex identity only changes when names change.
  const aliasKey = pubkeys
    .map((pk, i) => `${pk}:${aliasesFor(results[i]?.data).join('\u0000')}`)
    .join('|');

  return useMemo(() => {
    if (pubkeys.length === 0) return EMPTY;
    const byName = new Map<string, string>();
    pubkeys.forEach((pk, i) => {
      for (const alias of aliasesFor(results[i]?.data)) {
        const key = alias.toLowerCase();
        // First writer wins so a shared name stays deterministic.
        if (!byName.has(key)) byName.set(key, pk);
      }
    });
    if (byName.size === 0) return EMPTY;
    return { byName, regex: buildMentionRegex([...byName.keys()]) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aliasKey]);
}

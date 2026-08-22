import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Conversations } from "@/hooks/useDm17";
import { useDMConversations } from "@/hooks/useDirectMessages";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import {
  buildDmSwitcherEntries,
  type Dm17SwitcherSource,
  type LegacyDmSwitcherSource,
} from "@/lib/switcher";

/** One known DM conversation, reduced to what account-level activity UIs need. */
export interface DmActivityItem {
  /** Canonical participant-set key (a pubkey for 1:1, comma-joined for a group). */
  key: string;
  /** Everyone in the conversation except the viewer (`[self]` for Note to Self). */
  peers: string[];
  route: string;
  createdAt: number;
  eventId: string;
  author: string;
  content?: string;
  unread: boolean;
}

export interface DmActivityLegacySource extends LegacyDmSwitcherSource {
  latest: LegacyDmSwitcherSource["latest"] & { pubkey: string };
}

export interface DmActivityNip17Source extends Dm17SwitcherSource {
  latest: Dm17SwitcherSource["latest"] & { author: string; content: string };
}

/**
 * Merge legacy and NIP-17 conversation heads into newest-first activity rows.
 *
 * Identity/order deliberately comes from `buildDmSwitcherEntries`, the same
 * reducer used by the quick switcher. This layer only attaches the winning
 * message's author/content and the shared per-conversation read stamp. Legacy
 * wins an exact timestamp tie, matching the DMs page and switcher.
 */
export function buildDmActivityItems(
  legacy: readonly DmActivityLegacySource[],
  nip17: readonly DmActivityNip17Source[],
  previews: Readonly<Record<string, string>>,
  opts: {
    self: string;
    isKnown: (peer: string, mine: boolean) => boolean;
    getLastRead: (key: string) => number;
  },
): DmActivityItem[] {
  const entries = buildDmSwitcherEntries(legacy, nip17, {
    isKnown: opts.isKnown,
  });
  const legacyByKey = new Map(legacy.map((row) => [row.peer, row]));
  const nip17ByKey = new Map(nip17.map((row) => [row.key, row]));

  return entries.flatMap((entry) => {
    const old = legacyByKey.get(entry.key);
    const modern = nip17ByKey.get(entry.key);
    const modernWins = Boolean(
      modern && (!old || modern.latest.createdAt > old.latest.created_at),
    );
    const createdAt = modernWins ? modern!.latest.createdAt : old?.latest.created_at;
    const eventId = modernWins ? modern!.latest.rumorId : old?.latest.id;
    const author = modernWins ? modern!.latest.author : old?.latest.pubkey;
    if (!createdAt || !eventId || !author) return [];

    return [{
      key: entry.key,
      peers: entry.peers,
      route: entry.route,
      createdAt,
      eventId,
      author,
      content: modernWins ? modern!.latest.content : previews[entry.key],
      unread:
        author !== opts.self && createdAt > opts.getLastRead(dmReadKey(entry.key)),
    }];
  });
}

/**
 * Known, real-message DM conversations for recent/activity surfaces.
 *
 * `interactive` is reserved for a surface the user explicitly opened (the
 * Notification Center): it may decrypt legacy preview text and run the normal
 * NIP-17 consent flow. The always-mounted rail keeps it false, so it never
 * prompts a signer merely to show avatars and unread dots.
 */
export function useDmActivity(opts: { interactive?: boolean } = {}): {
  items: DmActivityItem[];
  isLoading: boolean;
} {
  const interactive = opts.interactive ?? false;
  const { user } = useCurrentUser();
  const { getLastRead } = useReadState();
  const { isKnown, isLoading: trustLoading } = useKnownDmPeers();
  const legacy = useDMConversations({ decryptPreviews: interactive });
  const modern = useDm17Conversations({ interactive });

  const items = useMemo(() => {
    if (!user || trustLoading) return [];
    return buildDmActivityItems(
      legacy.conversations,
      modern.conversations,
      legacy.previews,
      { self: user.pubkey, isKnown, getLastRead },
    );
  }, [
    user,
    trustLoading,
    legacy.conversations,
    legacy.previews,
    modern.conversations,
    isKnown,
    getLastRead,
  ]);

  return {
    items,
    isLoading: legacy.isLoading || modern.isLoading || trustLoading,
  };
}

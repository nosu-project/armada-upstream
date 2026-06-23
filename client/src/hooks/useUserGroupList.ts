import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import {
  buildGroupListTags,
  KIND_USER_GROUPS,
  parseGroupListTags,
  type GroupRef,
  type UserGroupList,
} from "@/lib/nip29";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";
import type { NUser } from "@nostrify/react/login";

/** Empty list, used before any 10009 event exists. */
const EMPTY_LIST: UserGroupList = { groups: [], servers: [] };

/** Result of reading a 10009 event, with a flag for a failed private-item decrypt. */
interface ReadGroupListResult extends UserGroupList {
  /**
   * True when the event had encrypted private items but decryption failed (no
   * signer, signer refused, or transient error). The parsed list is then only
   * the public tags — which are usually empty — so callers MUST NOT treat an
   * empty `servers`/`groups` as authoritative when this is set.
   */
  decryptFailed: boolean;
}

/**
 * Decrypt the NIP-44 private items of a kind 10009 event (NIP-51) and merge
 * them with the public tags. Private items live in `.content` as a stringified
 * tag array, encrypted to self. Falls back to public-only when there is no
 * signer or decryption fails.
 */
async function readGroupListEvent(
  event: NostrEvent | null,
  signer: NUser["signer"] | undefined,
): Promise<ReadGroupListResult> {
  if (!event) return { ...EMPTY_LIST, decryptFailed: false };

  const tags = [...event.tags];
  let decryptFailed = false;
  if (event.content && signer?.nip44) {
    try {
      const decrypted = await signer.nip44.decrypt(event.pubkey, event.content);
      const privateTags = JSON.parse(decrypted);
      if (Array.isArray(privateTags)) {
        for (const tag of privateTags) {
          if (Array.isArray(tag)) tags.push(tag as string[]);
        }
      }
    } catch (err) {
      console.warn("Failed to decrypt group list private items:", err);
      decryptFailed = true;
    }
  } else if (event.content && !signer?.nip44) {
    // There ARE encrypted items but we can't decrypt them (no nip44 signer).
    decryptFailed = true;
  }
  return { ...parseGroupListTags(tags), decryptFailed };
}

/**
 * The user's kind 10009 group list (NIP-51 "Simple groups"). This is the
 * cross-device source of truth for both joined channels (`group` tags) and the
 * servers the user has added (`r` tags). Private items are NIP-44 encrypted to
 * self in `.content`.
 */
export function useUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const queryKey = ["nip29", "user-groups", user?.pubkey];

  // Cache-first seed: hydrate the joined-channels list from IndexedDB so it
  // survives a refresh and renders before the network resolves. The 10009 event
  // is persisted by NostrBatcher; we read it back by (kind, author) and decrypt
  // its private items locally.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const store = await eventStore;
      const [cached] = await store.query([{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey] }]);
      if (cancelled || !cached) return;
      const list = await readGroupListEvent(cached, user.signer);
      if (cancelled || queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData(queryKey, {
        event: cached as NostrEvent | null,
        groups: list.groups,
        servers: list.servers,
        decryptFailed: list.decryptFailed,
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.pubkey, eventStore, queryClient]);

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [KIND_USER_GROUPS], authors: [user!.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
      const list = await readGroupListEvent(latest, user!.signer);
      return {
        event: latest as NostrEvent | null,
        groups: list.groups,
        servers: list.servers,
        decryptFailed: list.decryptFailed,
      };
    },
    enabled: Boolean(user),
    staleTime: 30_000,
  });
}

/** A single mutation against the user's kind 10009 list (read-modify-write). */
type GroupListAction =
  | { type: "add-group"; ref: GroupRef }
  | { type: "remove-group"; ref: GroupRef }
  | { type: "add-server"; url: string }
  | { type: "remove-server"; url: string }
  | { type: "reorder-servers"; urls: string[] };

function applyAction(list: UserGroupList, action: GroupListAction): UserGroupList {
  switch (action.type) {
    case "add-group": {
      const without = list.groups.filter(
        (g) => !(g.id === action.ref.id && g.relay === action.ref.relay),
      );
      return { ...list, groups: [...without, action.ref] };
    }
    case "remove-group":
      return {
        ...list,
        groups: list.groups.filter(
          (g) => !(g.id === action.ref.id && g.relay === action.ref.relay),
        ),
      };
    case "add-server": {
      const url = normalizeRelayUrl(action.url) ?? action.url;
      if (list.servers.includes(url)) return list;
      return { ...list, servers: [...list.servers, url] };
    }
    case "remove-server": {
      const url = normalizeRelayUrl(action.url) ?? action.url;
      return { ...list, servers: list.servers.filter((s) => s !== url) };
    }
    case "reorder-servers": {
      // Reorder the existing servers to match `urls`. Normalize and dedupe the
      // incoming order, keep only servers already in the list (so a stale
      // reorder can't add/drop entries), then append any servers the caller
      // omitted to avoid silently losing them.
      const known = new Set(list.servers);
      const desired: string[] = [];
      const seen = new Set<string>();
      for (const raw of action.urls) {
        const url = normalizeRelayUrl(raw) ?? raw;
        if (known.has(url) && !seen.has(url)) {
          seen.add(url);
          desired.push(url);
        }
      }
      for (const url of list.servers) {
        if (!seen.has(url)) desired.push(url);
      }
      return { ...list, servers: desired };
    }
  }
}

/**
 * Mutate the user's kind 10009 list (add/remove a group or a server) with a
 * read-modify-write against fresh relay state. Items are stored as NIP-44
 * private items (encrypted to self) in `.content`, matching NIP-51.
 */
export function useUpdateUserGroupList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutateAsync: publishEvent } = useNostrPublish();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (action: GroupListAction) => {
      if (!user) throw new Error("User is not logged in");
      if (!user.signer.nip44) {
        throw new Error("NIP-44 encryption not supported by this signer");
      }

      // Read-modify-write against fresh relay state, never the query cache.
      const events = await nostr.query(
        [{ kinds: [KIND_USER_GROUPS], authors: [user.pubkey], limit: 1 }],
        { signal: AbortSignal.timeout(8000) },
      );
      const prev = events.sort((a, b) => b.created_at - a.created_at)[0];
      const current = await readGroupListEvent(prev ?? null, user.signer);
      // Refuse to read-modify-write on top of a list we couldn't decrypt: the
      // private items (servers + joined groups) would read as empty and we'd
      // publish a list that wipes everything the user has. Better to fail the
      // action than to silently destroy their server/group list.
      if (current.decryptFailed) {
        throw new Error("Couldn't read your existing list (decryption failed); not saving to avoid data loss.");
      }
      const next = applyAction(current, action);

      // Preserve any unrelated tags (title, etc.) from the previous event, but
      // drop the public group/r items — those now live encrypted in .content.
      const otherTags =
        prev?.tags.filter(([name]) => name !== "group" && name !== "r") ?? [];

      const privateTags = buildGroupListTags(next);
      const content = await user.signer.nip44.encrypt(
        user.pubkey,
        JSON.stringify(privateTags),
      );

      return publishEvent({
        kind: KIND_USER_GROUPS,
        content,
        tags: otherTags,
        prev: prev ?? undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["nip29", "user-groups"] });
    },
  });
}

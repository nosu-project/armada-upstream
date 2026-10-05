import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useMutation, type UseMutationResult, useQuery, useQueryClient } from '@tanstack/react-query';

import { useCacheFirstSeed } from '@/hooks/useCacheFirstSeed';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useEventStore } from '@/hooks/useEventStore';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import type { NostrRumor } from "@/lib/nostrRumor";
import { sanitizeUrl } from "@/lib/sanitizeUrl";

/** NIP-38 user status. kind 30315, addressable by the `d` tag (status type). */
export const USER_STATUS_KIND = 30315;

/** The two status types defined by NIP-38. "general" is the default. */
export type UserStatusType = 'general' | 'music';

export interface UserStatus {
  /** The status message (kind-30315 content). Empty string = cleared. */
  content: string;
  /** NIP-38 `r` link, sanitized to http(s) here (it lands in an `href`) rather than at each render site. */
  link?: string;
  /** Unix seconds the status expires at, if the event carried an `expiration`. */
  expiration?: number;
  /** The underlying event, kept so callers can read emoji tags etc. */
  event: NostrRumor;
}

export type UserStatusResult = { status?: UserStatus };

/**
 * Whether a status's NIP-40 `expiration` has passed. Callers must check this
 * too: the parse-time check only runs when the event is (re)fetched.
 */
export function isStatusExpired(status: UserStatus | undefined, now = Date.now()): boolean {
  return (
    status?.expiration !== undefined &&
    Number.isFinite(status.expiration) &&
    status.expiration * 1000 <= now
  );
}

/**
 * Parse a kind-30315 event into a {@link UserStatus}. A status whose content is
 * empty, or whose `expiration` has already passed, is treated as "no status"
 * (NIP-38: an empty status clears it).
 */
export function parseUserStatusEvent(event: NostrRumor): UserStatusResult {
  const content = event.content.trim();
  const link = sanitizeUrl(event.tags.find(([name]) => name === 'r')?.[1]);
  const expirationTag = event.tags.find(([name]) => name === 'expiration')?.[1];
  const expiration = expirationTag ? Number(expirationTag) : undefined;

  if (!content) {
    return {};
  }
  if (expiration !== undefined && Number.isFinite(expiration) && expiration * 1000 <= Date.now()) {
    return {};
  }

  return {
    status: {
      content,
      link,
      expiration: expiration !== undefined && Number.isFinite(expiration) ? expiration : undefined,
      event,
    },
  };
}

function statusEvent(data: UserStatusResult): NostrRumor | undefined {
  return data.status?.event;
}

/**
 * Read a user's NIP-38 status (kind 30315). This query shape is batched by
 * `NostrBatcher` into a single REQ across authors. Never re-polled within a
 * session: publishes write straight into the cache, and polling misses would make
 * idle channels generate constant traffic.
 */
export function useUserStatus(
  pubkey: string | undefined,
  type: UserStatusType = 'general',
) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  useCacheFirstSeed<UserStatusResult>({
    queryKey: pubkey ? ['user-status', type, pubkey] : undefined,
    filter: { kinds: [USER_STATUS_KIND], authors: pubkey ? [pubkey] : [], '#d': [type] },
    toData: parseUserStatusEvent,
    getEvent: statusEvent,
  });

  return useQuery<UserStatusResult>({
    queryKey: ['user-status', type, pubkey ?? ''],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {};
      }

      const store = await eventStore;

      const [event] = await nostr.query(
        [{ kinds: [USER_STATUS_KIND], authors: [pubkey], '#d': [type], limit: 1 }],
        { signal },
      );

      if (!event) {
        // A status miss is transient — don't blank an already-shown status.
        const existing = queryClient.getQueryData<UserStatusResult>(['user-status', type, pubkey]);
        if (existing?.status) {
          return existing;
        }
        const [cached] = await store.query([
          { kinds: [USER_STATUS_KIND], authors: [pubkey], '#d': [type] },
        ]);
        if (cached) {
          return parseUserStatusEvent(cached);
        }
        return {};
      }

      void store.event(event);

      return parseUserStatusEvent(event);
    },
    enabled: !!pubkey,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export interface SetUserStatusInput {
  /** The status message. An empty/whitespace-only string clears the status. */
  content: string;
  /** Optional link the status points at (NIP-38 `r` tag). */
  link?: string;
  /** Status type / `d` tag. Defaults to "general". */
  type?: UserStatusType;
  /** NIP-30 emoji tags for custom emojis in the content. */
  emojiTags?: string[][];
}

/**
 * Publish (or clear, with empty content) the current user's NIP-38 status and
 * update the local query cache immediately.
 */
export function useSetUserStatus(): UseMutationResult<NostrEvent, Error, SetUserStatusInput> {
  const { mutateAsync: publish } = useNostrPublish();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ content, link, type = 'general', emojiTags }: SetUserStatusInput) => {
      const trimmed = content.trim();
      const tags: string[][] = [['d', type]];
      if (trimmed && link?.trim()) {
        tags.push(['r', link.trim()]);
      }
      if (trimmed && emojiTags?.length) {
        tags.push(...emojiTags);
      }

      const event = await publish({
        kind: USER_STATUS_KIND,
        content: trimmed,
        tags,
      });

      if (user) {
        queryClient.setQueryData<UserStatusResult>(
          ['user-status', type, user.pubkey],
          parseUserStatusEvent(event),
        );
      }

      return event;
    },
  });
}

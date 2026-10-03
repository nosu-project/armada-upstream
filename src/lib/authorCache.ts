/** `['author', pubkey]` cache helpers, split from `useAuthor` to avoid an import cycle with profileSync. */
import { type NostrMetadata, NSchema as n } from '@nostrify/nostrify';

import type { QueryClient } from '@tanstack/react-query';

import type { NostrRumor } from '@/lib/nostrRumor';

export type AuthorResult = {
  event?: NostrRumor;
  metadata?: NostrMetadata;
  /** The media hold removed a picture/banner from `metadata` (`useAuthor`). */
  imagesWithheld?: boolean;
};

export function authorQueryKey(pubkey: string): [string, string] {
  return ['author', pubkey];
}

/** Built once: `n.json()`/`n.metadata()` construct a zod pipeline per call (~0.25ms). */
export const metadataSchema = n.json().pipe(n.metadata());

/** Parse a kind-0 event into metadata + event, or return just the event on parse failure. */
export function parseAuthorEvent(event: NostrRumor): { event: NostrRumor; metadata?: NostrMetadata } {
  try {
    const metadata = metadataSchema.parse(event.content);
    return { metadata, event };
  } catch {
    return { event };
  }
}

/**
 * Seed a kind-0 event into the author cache only if newer than what's there.
 * All seeders must use this, or a background path can revert a fresher profile.
 */
export function seedAuthorCache(queryClient: QueryClient, pubkey: string, event: NostrRumor): void {
  const key = authorQueryKey(pubkey);
  const existing = queryClient.getQueryData<AuthorResult>(key);
  if (existing?.event && existing.event.created_at >= event.created_at) return;
  queryClient.setQueryData<AuthorResult>(key, parseAuthorEvent(event));
}

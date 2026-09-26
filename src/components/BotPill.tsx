import { Bot } from 'lucide-react';

import { useAuthor } from '@/hooks/useAuthor';
import { cn } from '@/lib/utils';

import type { NostrMetadata } from '@nostrify/nostrify';

interface BotPillProps {
  /**
   * Resolve the bot flag from this pubkey's kind-0 metadata. Ignored when
   * `metadata` is supplied.
   */
  pubkey?: string;
  /** Already-loaded metadata; skips the profile lookup when provided. */
  metadata?: NostrMetadata;
  className?: string;
}

/**
 * A small "Bot" pill shown next to a display name when the account's profile
 * metadata declares `bot: true` (NIP-24). Self-contained: pass a `pubkey` and
 * it resolves the flag via {@link useAuthor}, or pass already-loaded
 * `metadata` to skip the fetch (callers that render a name usually have it in
 * scope already). Renders nothing for non-bot or not-yet-known accounts, so it
 * can be dropped in next to any name unconditionally.
 */
export function BotPill({ pubkey, metadata, className }: BotPillProps) {
  // Only look the profile up when metadata wasn't handed to us and there is a
  // pubkey to look up. Even an inert `useAuthor(undefined)` is a query
  // observer, and a timeline renders a pill beside every byline.
  if (metadata || !pubkey) return <BotPillView metadata={metadata} className={className} />;
  return <ResolvedBotPill pubkey={pubkey} className={className} />;
}

function ResolvedBotPill({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  return <BotPillView metadata={author.data?.metadata} className={className} />;
}

function BotPillView({ metadata, className }: { metadata?: NostrMetadata; className?: string }) {
  if (metadata?.bot !== true) return null;

  return (
    <span
      title="Bot account"
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-500',
        className,
      )}
    >
      <Bot className="size-3" aria-hidden />
      Bot
    </span>
  );
}

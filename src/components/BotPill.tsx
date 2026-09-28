import { Bot } from 'lucide-react';

import { useAuthor } from '@/hooks/useAuthor';
import { cn } from '@/lib/utils';

import type { NostrMetadata } from '@nostrify/nostrify';

interface BotPillProps {
  /** Resolve the bot flag from this pubkey's kind-0. Ignored when `metadata` is supplied. */
  pubkey?: string;
  metadata?: NostrMetadata;
  className?: string;
}

/**
 * "Bot" pill when the profile declares `bot: true` (NIP-24). Renders nothing
 * for non-bot or unknown accounts.
 */
export function BotPill({ pubkey, metadata, className }: BotPillProps) {
  // Skip even an inert `useAuthor(undefined)`: a timeline renders one per byline.
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

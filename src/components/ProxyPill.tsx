import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import type { ProxyInfo } from '@/lib/nip48';

/**
 * Brand colors for bridges worth recognizing on sight, keyed by the proxy
 * URL's hostname. Everything else gets the neutral pill.
 */
const BRAND_CLASSES: Record<string, string> = {
  // Discord "blurple".
  'discord.com': 'bg-[#5865F2]/15 text-[#5865F2]',
  'discordapp.com': 'bg-[#5865F2]/15 text-[#5865F2]',
};

interface ProxyPillProps {
  /** Parsed NIP-48 proxy tag; renders nothing when absent. */
  proxy?: ProxyInfo | null;
  className?: string;
}

/**
 * A small pill shown next to a display name when the message was bridged in
 * from another network (NIP-48 `proxy` tag) — "Discord", "ActivityPub", or the
 * source hostname. Clicking it opens a popover naming the origin, linking to
 * the original message when the proxy id is a URL we can open.
 */
export function ProxyPill({ proxy, className }: ProxyPillProps) {
  if (!proxy) return null;

  const brand = proxy.host ? BRAND_CLASSES[proxy.host] : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`Bridged from ${proxy.label}`}
          className={cn(
            'shrink-0 inline-flex max-w-[10rem] items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            brand ?? 'bg-muted-foreground/15 text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{proxy.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[16rem] p-2 text-xs">
        Bridged from{' '}
        {proxy.url ? (
          <a
            href={proxy.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            {proxy.label}
          </a>
        ) : (
          <span className="font-medium">{proxy.label}</span>
        )}
      </PopoverContent>
    </Popover>
  );
}

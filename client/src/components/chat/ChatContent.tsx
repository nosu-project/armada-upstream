import { nip19 } from "nostr-tools";
import { Fragment, useMemo } from "react";

import { useAuthor } from "@/hooks/useAuthor";
import { getDisplayName } from "@/lib/getDisplayName";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";

import type { NostrEvent } from "@nostrify/nostrify";

const TOKEN_RE = /(https?:\/\/[^\s<>"']+|nostr:(?:npub1|nprofile1)[a-z0-9]+)/gi;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i;

function Mention({ bech32 }: { bech32: string }) {
  const pubkey = useMemo(() => {
    try {
      const decoded = nip19.decode(bech32);
      if (decoded.type === "npub") return decoded.data;
      if (decoded.type === "nprofile") return decoded.data.pubkey;
    } catch {
      // malformed identifier
    }
    return undefined;
  }, [bech32]);

  const author = useAuthor(pubkey);

  if (!pubkey) return <span>{bech32}</span>;
  return (
    <span className="text-primary font-medium">
      @{getDisplayName(author.data?.metadata, pubkey)}
    </span>
  );
}

interface ChatContentProps {
  event: NostrEvent;
  className?: string;
}

/**
 * Lightweight chat message renderer: linkifies URLs (sanitized), inlines
 * image links, and resolves nostr:npub/nprofile mentions to display names.
 */
export function ChatContent({ event, className }: ChatContentProps) {
  const parts = useMemo(() => event.content.split(TOKEN_RE), [event.content]);

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {parts.map((part, i) => {
        if (/^https?:\/\//i.test(part)) {
          const url = sanitizeUrl(part);
          if (!url) return <Fragment key={i}>{part}</Fragment>;
          if (IMAGE_RE.test(new URL(url).pathname)) {
            return (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block max-w-xs my-1">
                <img src={url} alt="" loading="lazy" className="rounded-lg max-h-64 object-contain" />
              </a>
            );
          }
          return (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 break-all">
              {part}
            </a>
          );
        }
        if (/^nostr:(npub1|nprofile1)/i.test(part)) {
          return <Mention key={i} bech32={part.slice(6)} />;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </span>
  );
}

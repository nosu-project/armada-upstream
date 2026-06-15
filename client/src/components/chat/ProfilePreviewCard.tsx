import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { EmojifiedText } from "@/components/chat/CustomEmoji";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { tryNpubEncode } from "@/lib/safeNip19";
import { cn } from "@/lib/utils";

interface ProfilePreviewCardProps {
  pubkey: string;
  /** The trigger element (e.g. an avatar). Rendered as the popover trigger. */
  children: React.ReactNode;
}

/** The body of the profile preview — banner, avatar, name, npub, and bio. */
function ProfilePreviewBody({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, pubkey);
  const avatarShape = getAvatarShape(metadata);
  const npub = tryNpubEncode(pubkey);
  const [copied, setCopied] = useState(false);

  const copyNpub = () => {
    if (!npub) return;
    navigator.clipboard?.writeText(npub).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const shortNpub = npub ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : "";

  return (
    <>
      {/* Mini banner */}
      <div className="h-16 bg-secondary relative">
        {metadata?.banner && (
          <img src={metadata.banner} alt="" className="w-full h-full object-cover" loading="lazy" />
        )}
      </div>

      <div className="px-4 pb-4">
        {/* Avatar overlapping the banner */}
        <div className="-mt-8 mb-2">
          <Avatar shape={avatarShape} className="size-16 border-[3px] border-background">
            <AvatarImage src={metadata?.picture} alt={displayName} />
            <AvatarFallback className="bg-primary/20 text-primary text-lg">
              {displayName[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </div>

        {/* Name */}
        <div className="font-bold text-[15px] truncate">
          {author.data?.event
            ? <EmojifiedText tags={author.data.event.tags}>{displayName}</EmojifiedText>
            : displayName}
        </div>

        {/* npub (copyable) */}
        {npub && (
          <button
            type="button"
            onClick={copyNpub}
            className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            title="Copy npub"
          >
            <span className="font-mono">{shortNpub}</span>
            {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
          </button>
        )}

        {/* Bio */}
        {metadata?.about && (
          <p className={cn(
            "text-sm text-muted-foreground mt-2 whitespace-pre-wrap break-words line-clamp-4",
          )}>
            {metadata.about}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * Wraps a trigger element (typically an avatar) with a click-triggered popover
 * showing a compact profile preview: banner, avatar, display name, npub, and
 * bio.
 */
export function ProfilePreviewCard({ pubkey, children }: ProfilePreviewCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-72 p-0 rounded-2xl overflow-hidden border border-border shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {open && <ProfilePreviewBody pubkey={pubkey} />}
      </PopoverContent>
    </Popover>
  );
}
